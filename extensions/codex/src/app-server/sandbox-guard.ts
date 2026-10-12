/**
 * Blocks direct Codex app-server requests that would bypass OpenClaw sandbox or
 * node-exec routing guarantees.
 */
import { tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveSandboxRuntimeStatus, type SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexRemoteExecPlacementSandbox } from "./config-parsing.js";
import {
  formatCodexNativeNodeExecBlock,
  prepareCodexNativeExecutionPolicy,
  resolveCodexNativeExecutionPolicy,
  type CodexNativeExecutionPolicy,
  type PreparedCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";

const ALLOWED_CONTROL_PLANE_METHODS = new Set([
  "account/rateLimits/read",
  "account/read",
  "app/installed",
  "app/list",
  "app/read",
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/read",
  "config/value/write",
  "environment/add",
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "feedback/upload",
  "hooks/list",
  "initialize",
  "marketplace/add",
  "mcpServerStatus/list",
  "model/list",
  "plugin/install",
  "plugin/installed",
  "plugin/list",
  "plugin/read",
  "skills/list",
  "thread/archive",
  "thread/inject_items",
  "thread/list",
  "thread/metadata/update",
  "thread/name/set",
  "thread/read",
  "thread/rollback",
  "thread/unarchive",
  "thread/unsubscribe",
  "turn/interrupt",
  "turn/steer",
]);

/** Returns a block message when a direct app-server method would bypass OpenClaw execution policy. */
export function resolveCodexAppServerDirectSandboxBypassBlock(params: {
  method: string;
  requestParams?: unknown;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  storePath?: string;
  sessionTarget?: Parameters<typeof resolveCodexNativeExecutionPolicy>[0]["sessionTarget"];
  executionPolicy?: CodexNativeExecutionPolicy;
  sandbox?: Pick<SandboxContext, "enabled"> | null;
}): string | undefined {
  const controlPlane = ALLOWED_CONTROL_PLANE_METHODS.has(params.method);
  // Reloading MCP servers can start app-backed processes in the Codex app-server environment.
  if (!controlPlane || params.method === "config/mcpServer/reload") {
    const nodeExecBlock = resolveCodexNativeNodeExecBlock({
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      storePath: params.storePath,
      sessionTarget: params.sessionTarget,
      executionPolicy: params.executionPolicy,
      surface: `app-server method \`${params.method}\``,
    });
    if (nodeExecBlock) {
      return nodeExecBlock;
    }
  }
  if (controlPlane) {
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const sandboxBlock = resolveCodexNativeSandboxBlock({
    ...params,
    sessionKey,
    surface: `app-server method \`${params.method}\``,
  });
  return sandboxBlock &&
    params.method === "thread/start" &&
    hasOpenClawSandboxEnvironmentSelection(params.requestParams)
    ? undefined
    : sandboxBlock;
}

/** Resolve policy before yielding to client acquisition and recheck it at each write. */
export async function prepareCodexAppServerDirectSandboxBypassBlock(
  params: Parameters<typeof resolveCodexAppServerDirectSandboxBypassBlock>[0],
): Promise<{ block: string | undefined } & Omit<PreparedCodexNativeExecutionPolicy, "policy">> {
  if (
    ALLOWED_CONTROL_PLANE_METHODS.has(params.method) &&
    params.method !== "config/mcpServer/reload"
  ) {
    return { block: undefined, async assertCurrent() {} };
  }
  const selected = await prepareCodexNativeExecutionPolicy({
    ...params,
    readRuntimeSessionEntry: true,
  });
  return {
    block: resolveCodexAppServerDirectSandboxBypassBlock({
      ...params,
      executionPolicy: selected.policy,
    }),
    assertCurrent: selected.assertCurrent,
    source: selected.source,
  };
}

export async function prepareCodexNativeExecutionBlock(
  params: Parameters<typeof resolveCodexNativeExecutionBlock>[0],
): Promise<{ block: string | undefined } & Omit<PreparedCodexNativeExecutionPolicy, "policy">> {
  const selected = await prepareCodexNativeExecutionPolicy({
    ...params,
    readRuntimeSessionEntry: true,
  });
  return {
    block: resolveCodexNativeExecutionBlock({ ...params, executionPolicy: selected.policy }),
    assertCurrent: selected.assertCurrent,
    source: selected.source,
  };
}

/** Resolves the generic native-execution block for sandboxed or node-hosted sessions. */
export function resolveCodexNativeExecutionBlock(
  params: Parameters<typeof resolveCodexNativeSandboxBlock>[0],
): string | undefined {
  return resolveCodexNativeSandboxBlock(params) ?? resolveCodexNativeNodeExecBlock(params);
}

/** Returns a block message when native Codex execution cannot honor active sandboxing. */
export function resolveCodexNativeSandboxBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  storePath?: string;
  sessionTarget?: Parameters<typeof resolveCodexNativeExecutionPolicy>[0]["sessionTarget"];
  executionPolicy?: CodexNativeExecutionPolicy;
  sandbox?: Pick<SandboxContext, "enabled"> | null;
  sandboxEnvironmentSelected?: boolean;
  surface: string;
}): string | undefined {
  if (params.sandboxEnvironmentSelected) {
    return undefined;
  }
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  if (!sessionKey) {
    return undefined;
  }
  if (isCodexRemoteExecPlacementSandbox(params.sandbox) || params.sandbox?.enabled === true) {
    return formatCodexNativeSandboxBlock({ surface: params.surface });
  }
  if (params.executionPolicy) {
    return params.executionPolicy.sandboxed
      ? formatCodexNativeSandboxBlock({ surface: params.surface })
      : undefined;
  }
  const sandboxAgentId =
    parseAgentSessionKey(sessionKey)?.agentId ??
    params.agentId ??
    tryResolveDefaultAgentId(params.config ?? {});
  if (!sandboxAgentId) {
    return undefined;
  }
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey,
    agentId: sandboxAgentId,
    classificationAgentId: sandboxAgentId,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }
  return formatCodexNativeSandboxBlock({ surface: params.surface });
}

function hasOpenClawSandboxEnvironmentSelection(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const environments = value.environments;
  return (
    Array.isArray(environments) &&
    environments.length > 0 &&
    environments.every(
      (environment) =>
        isRecord(environment) &&
        typeof environment.environmentId === "string" &&
        environment.environmentId.startsWith("openclaw-sandbox-") &&
        typeof environment.cwd === "string" &&
        environment.cwd.trim().length > 0,
    )
  );
}

function formatCodexNativeSandboxBlock(params: { surface: string }): string {
  return [
    `Codex-native ${params.surface} is unavailable because OpenClaw sandboxing is active for this session.`,
    "This mode cannot route execution through the OpenClaw sandbox backend.",
    "Use a normal Codex harness turn, or run an intentionally unsandboxed session.",
  ].join(" ");
}

function resolveCodexNativeNodeExecBlock(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  storePath?: string;
  sessionTarget?: Parameters<typeof resolveCodexNativeExecutionPolicy>[0]["sessionTarget"];
  executionPolicy?: CodexNativeExecutionPolicy;
  surface: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  const policy =
    params.executionPolicy ??
    resolveCodexNativeExecutionPolicy({
      config: params.config,
      sessionKey,
      agentId: params.agentId,
      storePath: params.storePath,
      sessionTarget: params.sessionTarget,
      readRuntimeSessionEntry: Boolean(sessionKey),
    });
  if (policy.nativeToolSurfaceAllowed) {
    return undefined;
  }
  return formatCodexNativeNodeExecBlock({
    surface: params.surface,
    reason: policy.blockReason,
  });
}
