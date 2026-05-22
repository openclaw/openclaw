import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveRuntimeExecDefaults } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSandboxRuntimeStatus } from "openclaw/plugin-sdk/sandbox";

type ExecHost = "sandbox" | "gateway" | "node";
type ExecTarget = "auto" | ExecHost;
type ExecHostOverride = Pick<
  NonNullable<EmbeddedRunAttemptParams["execOverrides"]>,
  "host" | "node"
>;

export type CodexNativeExecutionPolicy = {
  nativeToolSurfaceAllowed: boolean;
  requestedExecHost: ExecTarget;
  effectiveExecHost: ExecHost;
  node?: string;
  blockReason?: string;
};

export function resolveCodexNativeExecutionPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  execOverrides?: ExecHostOverride;
  sandboxAvailable?: boolean;
  readRuntimeSessionEntry?: boolean;
}): CodexNativeExecutionPolicy {
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim();
  const sandboxAvailable = resolveSandboxAvailable({
    config: params.config,
    sessionKey,
    sandboxAvailable: params.sandboxAvailable,
  });
  const defaults = resolveRuntimeExecDefaults({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey,
    sandboxAvailable,
    readRuntimeSessionEntry: params.readRuntimeSessionEntry,
  });
  const requestedExecHost = params.execOverrides?.host ?? defaults.host;
  const effectiveExecHost = resolveEffectiveHost({
    requestedExecHost,
    defaultExecHost: defaults.host,
    defaultEffectiveHost: defaults.effectiveHost,
    sandboxAvailable,
  });
  const node = params.execOverrides?.node ?? defaults.node;
  if (effectiveExecHost !== "node") {
    return {
      nativeToolSurfaceAllowed: true,
      requestedExecHost,
      effectiveExecHost,
      node,
    };
  }
  return {
    nativeToolSurfaceAllowed: false,
    requestedExecHost,
    effectiveExecHost,
    node,
    blockReason:
      "OpenClaw exec host=node is active for this session. Codex app-server native execution cannot route shell, filesystem, MCP, or app-backed work through the selected OpenClaw node.",
  };
}

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

function resolveEffectiveHost(params: {
  requestedExecHost: ExecTarget;
  defaultExecHost: ExecTarget;
  defaultEffectiveHost: ExecHost;
  sandboxAvailable: boolean;
}): ExecHost {
  if (params.requestedExecHost !== "auto") {
    return params.requestedExecHost;
  }
  if (params.defaultExecHost === "auto") {
    return params.defaultEffectiveHost;
  }
  return params.sandboxAvailable ? "sandbox" : "gateway";
}

function resolveSandboxAvailable(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): boolean {
  if (params.sandboxAvailable !== undefined) {
    return params.sandboxAvailable;
  }
  if (!params.sessionKey) {
    return false;
  }
  return resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: params.sessionKey,
  }).sandboxed;
}
