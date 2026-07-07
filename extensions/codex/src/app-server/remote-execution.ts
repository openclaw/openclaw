/** Remote-execution compatibility checks that require a live Codex app-server. */
import { getBeforeToolCallPolicyDiagnosticState } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/**
 * Managed command hooks ignore per-thread disablement in Codex 0.142.x. Reject
 * them before thread startup because they inherit the app-server environment
 * and try to use the executor-native cwd on the Gateway host.
 */
export async function ensureCodexRemoteExecutionCompatibility(params: {
  appServer: Pick<CodexAppServerRuntimeOptions, "remoteExecutionFingerprint" | "requestTimeoutMs">;
  client: CodexAppServerClient;
  cwd: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.appServer.remoteExecutionFingerprint) {
    return;
  }
  const beforeToolCallPolicy = getBeforeToolCallPolicyDiagnosticState();
  if (
    beforeToolCallPolicy.hasBeforeToolCallHook ||
    beforeToolCallPolicy.trustedToolPolicies.length > 0
  ) {
    throw new Error(
      "Codex remote execution cannot enforce OpenClaw before_tool_call or trusted-tool policy until Codex supports Gateway-local native hooks",
    );
  }
  let requirementsRead: JsonValue;
  try {
    requirementsRead = await params.client.request(
      "configRequirements/read",
      {},
      { timeoutMs: params.appServer.requestTimeoutMs, signal: params.signal },
    );
  } catch (cause) {
    throw new Error("Codex remote execution could not verify managed feature requirements", {
      cause,
    });
  }
  if (!isJsonObject(requirementsRead)) {
    throw new Error("Codex remote execution received an invalid configRequirements/read response");
  }
  const requirements = requirementsRead.requirements;
  if (requirements != null && !isJsonObject(requirements)) {
    throw new Error("Codex remote execution received invalid managed feature requirements");
  }
  const featureRequirements = isJsonObject(requirements)
    ? requirements.featureRequirements
    : undefined;
  if (featureRequirements != null && !isJsonObject(featureRequirements)) {
    throw new Error("Codex remote execution received invalid managed feature requirements");
  }
  const requiredFeatures = featureRequirements as JsonObject | undefined;
  if (
    requiredFeatures?.unified_exec === false ||
    requiredFeatures?.shell_zsh_fork === true ||
    requiredFeatures?.unified_exec_zsh_fork === true ||
    requiredFeatures?.hooks === true
  ) {
    throw new Error(
      "Codex remote execution is incompatible with managed feature requirements that override its execution safety policy",
    );
  }

  let configRead: JsonValue;
  try {
    configRead = await params.client.request(
      "config/read",
      { includeLayers: true, cwd: params.cwd },
      { timeoutMs: params.appServer.requestTimeoutMs, signal: params.signal },
    );
  } catch (cause) {
    throw new Error("Codex remote execution could not verify managed configuration precedence", {
      cause,
    });
  }
  if (
    !isJsonObject(configRead) ||
    !isJsonObject(configRead.config) ||
    !Array.isArray(configRead.layers)
  ) {
    throw new Error("Codex remote execution received an invalid config/read response");
  }
  for (const layer of configRead.layers) {
    if (!isJsonObject(layer) || !isJsonObject(layer.name)) {
      throw new Error("Codex remote execution received an invalid config layer");
    }
    const type = layer.name.type;
    if (
      (type === "legacyManagedConfigTomlFromFile" || type === "legacyManagedConfigTomlFromMdm") &&
      layer.disabledReason == null
    ) {
      throw new Error(
        "Codex remote execution cannot safely override an active legacy managed_config.toml layer",
      );
    }
  }
  const mcpServers = isJsonObject(configRead.config.mcp_servers)
    ? configRead.config.mcp_servers
    : undefined;
  for (const [name, server] of Object.entries(mcpServers ?? {})) {
    if (
      isJsonObject(server) &&
      server.enabled !== false &&
      typeof server.command === "string" &&
      server.environment_id !== "remote"
    ) {
      throw new Error(
        `Codex remote execution cannot use local stdio MCP server ${JSON.stringify(name)} because Codex 0.142.x removes its local execution environment`,
      );
    }
  }

  let data: JsonValue[];
  try {
    const response = await params.client.request(
      "hooks/list",
      { cwds: [params.cwd] },
      { timeoutMs: params.appServer.requestTimeoutMs, signal: params.signal },
    );
    data = response.data;
  } catch (cause) {
    throw new Error(
      "Codex remote execution could not verify that managed command hooks are absent",
      { cause },
    );
  }

  if (data.length === 0) {
    throw new Error("Codex remote execution received an empty hooks/list response");
  }
  const managedCommands: string[] = [];
  for (const entry of data) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors)) {
      throw new Error("Codex remote execution received an invalid hooks/list response");
    }
    if (entry.errors.length > 0) {
      throw new Error("Codex remote execution could not inspect hooks for its local workspace");
    }
    for (const value of entry.hooks) {
      if (!isJsonObject(value)) {
        throw new Error("Codex remote execution received an invalid hooks/list response");
      }
      if (
        typeof value.isManaged !== "boolean" ||
        typeof value.enabled !== "boolean" ||
        typeof value.handlerType !== "string"
      ) {
        throw new Error("Codex remote execution received an invalid hook description");
      }
      if (!value.isManaged || !value.enabled || value.handlerType !== "command") {
        continue;
      }
      const source = typeof value.source === "string" ? value.source : "managed";
      const eventName = typeof value.eventName === "string" ? value.eventName : "hook";
      managedCommands.push(`${source}:${eventName}`);
    }
  }
  if (managedCommands.length > 0) {
    throw new Error(
      `Codex remote execution cannot run with managed command hooks (${managedCommands.toSorted().join(", ")}) because Codex runs them on the app-server host with the remote cwd`,
    );
  }
}
