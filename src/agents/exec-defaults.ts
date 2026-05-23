import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadExecApprovals,
  type ExecAsk,
  type ExecHost,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  maxAsk,
  minSecurity,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
  resolveExecPolicyForMode,
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

function hasLegacyExecPolicyOverride(exec?: ResolvedExecConfig): boolean {
  return exec?.security !== undefined || exec?.ask !== undefined;
}

type LayeredExecPolicy = {
  mode?: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
};

function applyExecPolicyLayer(
  base: LayeredExecPolicy,
  layer?: ResolvedExecConfig,
): LayeredExecPolicy {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    };
  }
  if (hasLegacyExecPolicyOverride(layer)) {
    return {
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}

function applySessionExecPolicyLayer(
  base: LayeredExecPolicy,
  sessionEntry?: SessionEntry,
): LayeredExecPolicy {
  if (sessionEntry?.execMode) {
    const mode = sessionEntry.execMode as ExecMode;
    return {
      mode,
      ...resolveExecPolicyForMode(mode),
    };
  }
  if (sessionEntry?.execSecurity !== undefined || sessionEntry?.execAsk !== undefined) {
    return {
      security: (sessionEntry.execSecurity as ExecSecurity | undefined) ?? base.security,
      ask: (sessionEntry.execAsk as ExecAsk | undefined) ?? base.ask,
    };
  }
  return base;
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
  elevatedRequested?: boolean;
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
    elevatedRequested: params.elevatedRequested === true,
    sandboxAvailable,
  });
  const approvalDefaults =
    resolved.effectiveHost === "sandbox" ? undefined : loadExecApprovals().defaults;
  const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
  const basePolicy: LayeredExecPolicy = {
    security: approvalDefaults?.security ?? defaultSecurity,
    ask: approvalDefaults?.ask ?? "off",
  };
  const layeredPolicy = applySessionExecPolicyLayer(
    applyExecPolicyLayer(applyExecPolicyLayer(basePolicy, globalExec), agentExec),
    params.sessionEntry,
  );
  const modePolicy = resolveExecModePolicy(layeredPolicy);
  const security =
    approvalDefaults?.security !== undefined
      ? minSecurity(modePolicy.security, approvalDefaults.security)
      : modePolicy.security;
  const ask =
    approvalDefaults?.ask !== undefined
      ? maxAsk(modePolicy.ask, approvalDefaults.ask)
      : modePolicy.ask;
  const mode =
    security === modePolicy.security && ask === modePolicy.ask
      ? modePolicy.mode
      : resolveExecModeFromPolicy({ security, ask });
  return {
    host,
    effectiveHost: resolved.effectiveHost,
    mode,
    security,
    ask,
    node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
    canRequestNode: isRequestedExecTargetAllowed({
      configuredTarget: host,
      requestedTarget: "node",
      sandboxAvailable,
    }),
  };
}
