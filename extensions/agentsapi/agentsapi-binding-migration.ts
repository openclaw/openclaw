import { createHash } from "node:crypto";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentsApiBinding, LegacyAgentsApiBinding } from "./agentsapi-binding-record.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import { resolveAgentsApiSessionAccessError } from "./agentsapi-errors.js";
import { buildAgentsApiMcpTools } from "./agentsapi-mcp.js";
import {
  agentsApiConfigSchema,
  requireAgentsApiSessionFingerprint,
  resolveAgentsApiEnvironment,
  resolveAgentsApiNativeToolPolicy,
} from "./config.js";

/** The binding owner calls this once, under its lease, before admitting legacy state. */
export async function migrateAgentsApiBinding(
  binding: LegacyAgentsApiBinding,
  params: AgentHarnessAttemptParamsV2,
  readPluginConfig: () => unknown,
  assertCurrent: () => void,
): Promise<AgentsApiBinding> {
  const assertMigrationCurrent = () => {
    assertCurrent();
    params.abortSignal?.throwIfAborted();
  };
  assertMigrationCurrent();
  const config = agentsApiConfigSchema.parse(readPluginConfig() ?? {});
  const environment = resolveAgentsApiEnvironment(config, params.workspaceDir);
  const { webSearchEnabled } = resolveAgentsApiNativeToolPolicy(params, config);
  const mcpTools = await buildAgentsApiMcpTools(params);
  assertMigrationCurrent();
  // v2026.9.9 wrote [model, key, ...selfHostedEnvironment]. Later authFingerprint
  // writers added explicit hosted network policy and MCP. Empty additions keep
  // the shipped producer's exact bytes; never revive its unmerged-tools fallback.
  const identity = [
    params.model.id,
    params.resolvedApiKey,
    ...(environment.type === "self_hosted" || environment.network != null ? [environment] : []),
    ...(mcpTools.length ? [mcpTools] : []),
  ];
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  if (
    binding.authFingerprint !== fingerprint ||
    !webSearchEnabled ||
    (environment.type === "self_hosted" && config.executorController)
  ) {
    // A digest cannot separate changed credentials from changed configuration.
    // Session retrieval is not equivalent evidence: MCP responses omit secrets,
    // and effective environment defaults do not recover the authored identity.
    throw new Error(
      "Agents API legacy binding cannot verify the original model, API key, environment, MCP, or web-search policy; restore the original configuration and API key and retry, or reset the OpenClaw session to settle the saved native session with a currently authorized key. The saved binding has been retained.",
    );
  }
  // A matching historical digest proves configuration, not current API access.
  // No input, remote update, or local conversion precedes this authenticated read.
  try {
    const signal = params.abortSignal
      ? AbortSignal.any([params.abortSignal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const session = await new AgentsApiClient(
      params.resolvedApiKey!,
      assertMigrationCurrent,
    ).session(binding.sessionId, signal);
    assertMigrationCurrent();
    if (session.id !== binding.sessionId) {
      throw new Error("Agents API returned a different session during legacy migration");
    }
  } catch (error) {
    throw resolveAgentsApiSessionAccessError(error, binding.sessionId);
  }
  return {
    sessionId: binding.sessionId,
    configFingerprint: requireAgentsApiSessionFingerprint({
      model: params.model.id,
      environment,
      mcpTools,
      webSearchEnabled,
    }),
  };
}
