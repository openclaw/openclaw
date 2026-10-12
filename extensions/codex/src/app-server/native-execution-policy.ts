import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAgentConfig,
  tryResolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveSandboxRuntimeStatus } from "openclaw/plugin-sdk/sandbox";
import {
  captureSessionEntryCurrentCheckAsync,
  type PreparedSessionSourceAssertion,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { getSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

type ExecHost = "sandbox" | "gateway" | "node";
type ExecTarget = "auto" | ExecHost;

type ExecHostOverride = {
  host?: string;
  node?: string;
};

/** Effective execution-host policy for the Codex app-server native tool surface. */
export type CodexNativeExecutionPolicy = {
  nativeToolSurfaceAllowed: boolean;
  sandboxed: boolean;
  requestedExecHost: ExecTarget;
  effectiveExecHost: ExecHost;
  node?: string;
  blockReason?: string;
};

export type PreparedCodexNativeExecutionPolicy = {
  policy: CodexNativeExecutionPolicy;
  assertCurrent: () => Promise<void>;
  source?: PreparedSessionSourceAssertion;
};

type RunPolicyOptions = {
  agentId?: string;
  runtimeSessionKey?: string;
  sandbox?: Awaited<ReturnType<typeof resolveSandboxContext>>;
};

function resolveRunPolicyParams(params: EmbeddedRunAttemptParams, options: RunPolicyOptions) {
  return {
    config: params.config,
    sessionKey:
      options.runtimeSessionKey?.trim() ||
      params.sandboxSessionKey?.trim() ||
      params.sessionKey?.trim() ||
      params.sessionId,
    sessionId: params.sessionId,
    agentId: options.agentId,
    sessionTarget: params.sessionTarget,
    execOverrides: params.execOverrides,
    // A resolved null sandbox is absence; undefined still requests runtime discovery.
    sandboxAvailable: options.sandbox === null ? false : options.sandbox?.enabled,
    readRuntimeSessionEntry: true,
  };
}

export function resolveCodexNativeExecutionPolicyForRun(
  params: EmbeddedRunAttemptParams,
  options: RunPolicyOptions = {},
): CodexNativeExecutionPolicy {
  return resolveCodexNativeExecutionPolicy(resolveRunPolicyParams(params, options));
}

export function prepareCodexNativeExecutionPolicyForRun(
  params: EmbeddedRunAttemptParams,
  options: RunPolicyOptions = {},
): Promise<PreparedCodexNativeExecutionPolicy> {
  return prepareCodexNativeExecutionPolicy(resolveRunPolicyParams(params, options));
}

/** Prepare the selected row once; retained checks use its exact execution policy. */
export async function prepareCodexNativeExecutionPolicy(
  params: Parameters<typeof resolveCodexNativeExecutionPolicy>[0],
): Promise<PreparedCodexNativeExecutionPolicy> {
  const captured = {
    ...params,
    execOverrides: params.execOverrides && { ...params.execOverrides },
    sessionTarget: params.sessionTarget && { ...params.sessionTarget },
  };
  const { sourceAgentId, sourceSessionKey, canReadSessionEntry } =
    resolveSessionSelection(captured);
  if (!canReadSessionEntry || !sourceAgentId || !sourceSessionKey) {
    return { policy: resolveCodexNativeExecutionPolicy(captured), async assertCurrent() {} };
  }
  const selected = await captureSessionEntryCurrentCheckAsync({
    agentId: sourceAgentId,
    sessionKey: sourceSessionKey,
    storePath: captured.sessionTarget?.storePath ?? captured.storePath,
    fields: ["sessionId", "lifecycleRevision", "execHost", "execNode", "sandbox", "sandboxMode"],
    errorMessage: "Codex session execution policy changed; prepare the operation again.",
  });
  return {
    policy: resolveCodexNativeExecutionPolicy({
      ...captured,
      sessionEntry: selected.entry ?? null,
      readRuntimeSessionEntry: false,
    }),
    assertCurrent: selected.assertCurrent,
    source: selected.source,
  };
}

/** Projects node execution ownership into the runtime tool factory options. */
export function resolveCodexNodeExecToolOverrides(
  policy: CodexNativeExecutionPolicy,
): { host: "node"; node?: string } | undefined {
  if (policy.effectiveExecHost !== "node") {
    return undefined;
  }
  const node = policy.node?.trim();
  return { host: "node", ...(node ? { node } : {}) };
}

/** Resolves node/gateway/sandbox execution ownership from overrides, session, agent, and config. */
export function resolveCodexNativeExecutionPolicy(params: {
  config?: OpenClawConfig;
  /** Null carries acknowledged absence from an already selected physical source. */
  sessionEntry?: SessionEntry | null;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  storePath?: string;
  sessionTarget?: { agentId?: string; sessionKey?: string; storePath?: string };
  execOverrides?: ExecHostOverride;
  sandboxAvailable?: boolean;
  readRuntimeSessionEntry?: boolean;
}): CodexNativeExecutionPolicy {
  const config = params.config ?? {};
  const { agentId, sessionKey, sourceAgentId, sourceSessionKey, canReadSessionEntry } =
    resolveSessionSelection(params);
  let sessionEntry = params.sessionEntry;
  if (sessionEntry === undefined && canReadSessionEntry && sourceSessionKey && sourceAgentId) {
    sessionEntry =
      getSessionEntry({
        sessionKey: sourceSessionKey,
        agentId: sourceAgentId,
        ...((params.sessionTarget?.storePath ?? params.storePath)
          ? { storePath: params.sessionTarget?.storePath ?? params.storePath }
          : {}),
        hydrateSkillPromptRefs: false,
      }) ?? null;
  }
  const sandboxAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? agentId;
  // Stored overrides follow the captured source; main/non-main classification keeps its run key.
  const sandboxed =
    params.sandboxAvailable === true ||
    ((sessionEntry !== undefined || params.sandboxAvailable === undefined) &&
    sessionKey &&
    sandboxAgentId
      ? resolveSandboxRuntimeStatus({
          cfg: config,
          sessionKey,
          agentId: sandboxAgentId,
          classificationAgentId: sandboxAgentId,
          ...(sessionEntry !== undefined ? { preparedSessionEntry: sessionEntry } : {}),
        }).sandboxed
      : false);
  const sandboxAvailable = params.sandboxAvailable ?? sandboxed;
  const agentExec = agentId ? resolveAgentConfig(config, agentId)?.tools?.exec : undefined;
  const globalExec = config.tools?.exec;
  const requestedExecHost =
    normalizeExecTarget(params.execOverrides?.host) ??
    normalizeExecTarget(sessionEntry?.execHost) ??
    normalizeExecTarget(agentExec?.host) ??
    normalizeExecTarget(globalExec?.host) ??
    "auto";
  const effectiveExecHost =
    requestedExecHost === "auto" ? (sandboxAvailable ? "sandbox" : "gateway") : requestedExecHost;
  const node =
    params.execOverrides?.node ?? sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node;
  return {
    nativeToolSurfaceAllowed: effectiveExecHost !== "node",
    sandboxed,
    requestedExecHost,
    effectiveExecHost,
    node,
    ...(effectiveExecHost === "node"
      ? {
          blockReason:
            "OpenClaw exec host=node is active for this session. Codex app-server native execution cannot route shell, filesystem, MCP, or app-backed work through the selected OpenClaw node.",
        }
      : {}),
  };
}

function resolveSessionSelection(params: Parameters<typeof resolveCodexNativeExecutionPolicy>[0]) {
  const config = params.config ?? {};
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
  const agentId =
    normalizeAgentIdOrDefault(params.agentId) ??
    parseAgentIdFromSessionKey(sessionKey) ??
    tryResolveDefaultAgentId(config);
  return {
    sessionKey,
    agentId,
    sourceSessionKey: params.sessionTarget?.sessionKey ?? sessionKey,
    sourceAgentId: params.sessionTarget?.agentId ?? agentId,
    canReadSessionEntry:
      params.sessionEntry === undefined &&
      params.readRuntimeSessionEntry &&
      (params.sessionTarget !== undefined ||
        (parseAgentIdFromSessionKey(sessionKey) ?? tryResolveDefaultAgentId(config)) === agentId),
  };
}

/** Formats the user-facing explanation shown when native tools are blocked by exec host=node. */
export function formatCodexNativeNodeExecBlock(params: {
  surface: string;
  reason?: string;
}): string {
  return [
    `Codex-native ${params.surface} is unavailable because OpenClaw exec host=node is active for this session.`,
    params.reason ??
      "Codex app-server native execution cannot route execution through the selected OpenClaw node.",
    "Use a normal Codex harness turn so OpenClaw exec/process tools run on the node, or switch exec host to gateway for native Codex app-server execution.",
  ].join(" ");
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const parts = raw.toLowerCase().split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent" || !parts[2]) {
    return undefined;
  }
  return normalizeAgentIdOrDefault(parts[1]);
}

function normalizeAgentIdOrDefault(value?: string | null): string | undefined {
  const normalized = normalizeAgentId(value);
  return normalized === "main" && !(value ?? "").trim() ? undefined : normalized;
}

function normalizeExecTarget(value?: string | null): ExecTarget | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "sandbox" ||
    normalized === "gateway" ||
    normalized === "node"
  ) {
    return normalized;
  }
  return undefined;
}
