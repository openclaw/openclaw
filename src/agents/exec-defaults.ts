import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadExecApprovals,
  type ExecAsk,
  type ExecHost,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  resolveExecModePolicy,
} from "../infra/exec-approvals.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { isRequestedExecTargetAllowed, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

type ResolvedExecConfig = {
  host?: ExecTarget;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
};

function hasSessionExecPolicyOverride(sessionEntry?: SessionEntry): boolean {
  return sessionEntry?.execSecurity !== undefined || sessionEntry?.execAsk !== undefined;
}

function hasLegacyExecPolicyOverride(exec?: ResolvedExecConfig): boolean {
  return exec?.security !== undefined || exec?.ask !== undefined;
}

function resolveLayeredExecMode(params: {
  sessionEntry?: SessionEntry;
  agentExec?: ResolvedExecConfig;
  globalExec?: ResolvedExecConfig;
}): ExecMode | undefined {
  if (params.sessionEntry?.execMode) {
    return params.sessionEntry.execMode as ExecMode;
  }
  if (hasSessionExecPolicyOverride(params.sessionEntry)) {
    return undefined;
  }
  if (params.agentExec?.mode) {
    return params.agentExec.mode;
  }
  if (hasLegacyExecPolicyOverride(params.agentExec)) {
    return undefined;
  }
  return params.globalExec?.mode;
}

function resolveExecConfigState(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
}): {
  cfg: OpenClawConfig;
  host: ExecTarget;
  agentExec?: ResolvedExecConfig;
  globalExec?: ResolvedExecConfig;
} {
  const cfg = params.cfg ?? {};
  const resolvedAgentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: cfg,
    });
  const globalExec = cfg.tools?.exec;
  const agentExec = resolvedAgentId
    ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec
    : undefined;
  const host =
    (params.sessionEntry?.execHost as ExecTarget | undefined) ??
    (agentExec?.host as ExecTarget | undefined) ??
    (globalExec?.host as ExecTarget | undefined) ??
    "auto";
  return {
    cfg,
    host,
    agentExec,
    globalExec,
  };
}

function resolveExecSandboxAvailability(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}) {
  return (
    params.sandboxAvailable ??
    (params.sessionKey
      ? resolveSandboxRuntimeStatus({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }).sandboxed
      : false)
  );
}

export function canExecRequestNode(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): boolean {
  const { cfg, host } = resolveExecConfigState(params);
  return isRequestedExecTargetAllowed({
    configuredTarget: host,
    requestedTarget: "node",
    sandboxAvailable: resolveExecSandboxAvailability({
      cfg,
      sessionKey: params.sessionKey,
      sandboxAvailable: params.sandboxAvailable,
    }),
  });
}

export function resolveExecDefaults(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): {
  host: ExecTarget;
  effectiveHost: ExecHost;
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
  node?: string;
  canRequestNode: boolean;
} {
  const { cfg, host, agentExec, globalExec } = resolveExecConfigState(params);
  const sandboxAvailable = resolveExecSandboxAvailability({
    cfg,
    sessionKey: params.sessionKey,
    sandboxAvailable: params.sandboxAvailable,
  });
  const resolved = resolveExecTarget({
    configuredTarget: host,
    elevatedRequested: false,
    sandboxAvailable,
  });
  const approvalDefaults = loadExecApprovals().defaults;
  const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
  const rawSecurity =
    (params.sessionEntry?.execSecurity as ExecSecurity | undefined) ??
    agentExec?.security ??
    globalExec?.security ??
    approvalDefaults?.security ??
    defaultSecurity;
  const rawAsk =
    (params.sessionEntry?.execAsk as ExecAsk | undefined) ??
    agentExec?.ask ??
    globalExec?.ask ??
    approvalDefaults?.ask ??
    "off";
  const modePolicy = resolveExecModePolicy({
    mode: resolveLayeredExecMode({
      sessionEntry: params.sessionEntry,
      agentExec,
      globalExec,
    }),
    security: rawSecurity,
    ask: rawAsk,
  });
  return {
    host,
    effectiveHost: resolved.effectiveHost,
    mode: modePolicy.mode,
    security: modePolicy.security,
    ask: modePolicy.ask,
    node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
    canRequestNode: isRequestedExecTargetAllowed({
      configuredTarget: host,
      requestedTarget: "node",
      sandboxAvailable,
    }),
  };
}
