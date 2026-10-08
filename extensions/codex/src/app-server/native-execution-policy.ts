import {
  resolveAgentConfig,
  tryResolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveSandboxRuntimeStatus } from "openclaw/plugin-sdk/sandbox";
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
  requestedExecHost: ExecTarget;
  effectiveExecHost: ExecHost;
  node?: string;
  blockReason?: string;
};

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
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  execOverrides?: ExecHostOverride;
  sandboxAvailable?: boolean;
  readRuntimeSessionEntry?: boolean;
}): CodexNativeExecutionPolicy {
  const config = params.config ?? {};
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
  const agentId =
    normalizeAgentIdOrDefault(params.agentId) ??
    parseAgentIdFromSessionKey(sessionKey) ??
    tryResolveDefaultAgentId(config);
  const canReadSessionEntry =
    agentId &&
    sessionKey &&
    params.readRuntimeSessionEntry &&
    (parseAgentIdFromSessionKey(sessionKey) ?? tryResolveDefaultAgentId(config)) === agentId;
  let sessionEntry = params.sessionEntry ?? undefined;
  if (sessionEntry === undefined && canReadSessionEntry && sessionKey && agentId) {
    try {
      sessionEntry = getSessionEntry({ sessionKey, agentId, hydrateSkillPromptRefs: false });
    } catch {
      sessionEntry = undefined;
    }
  }
  const sandboxAgentId = parseAgentSessionKey(sessionKey)?.agentId ?? agentId;
  const sandboxAvailable =
    params.sandboxAvailable ??
    (sessionKey && sandboxAgentId
      ? resolveSandboxRuntimeStatus({
          cfg: config,
          sessionKey,
          agentId: sandboxAgentId,
          classificationAgentId: sandboxAgentId,
        }).sandboxed
      : false);
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
