import { resolveExecCommandHighlighting } from "../config/exec-command-highlighting.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
  resolveExecPolicyForMode,
} from "../infra/exec-approvals.js";
import { resolveMergedSafeBinProfileFixtures } from "../infra/exec-safe-bin-runtime-policy.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export function hasLegacyExecPolicy(exec?: ExecPolicyLayer): boolean {
  return exec?.security !== undefined || exec?.ask !== undefined;
}

export function applyExecPolicyLayer(
  base: ExecPolicyLayer,
  layer?: ExecPolicyLayer,
): ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    };
  }
  if (hasLegacyExecPolicy(layer)) {
    return {
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}

export function resolveExecConfig(params: { cfg?: OpenClawConfig; agentId?: string }) {
  const cfg = params.cfg;
  const globalExec = cfg?.tools?.exec;
  const agentExec =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec : undefined;
  const layeredPolicy = applyExecPolicyLayer(applyExecPolicyLayer({}, globalExec), agentExec);
  return {
    host: agentExec?.host ?? globalExec?.host,
    mode: layeredPolicy.mode,
    security: layeredPolicy.security,
    ask: layeredPolicy.ask,
    node: agentExec?.node ?? globalExec?.node,
    pathPrepend: agentExec?.pathPrepend ?? globalExec?.pathPrepend,
    safeBins: agentExec?.safeBins ?? globalExec?.safeBins,
    strictInlineEval: agentExec?.strictInlineEval ?? globalExec?.strictInlineEval,
    commandHighlighting: resolveExecCommandHighlighting({
      config: cfg,
      agentId: params.agentId,
    }),
    safeBinTrustedDirs: agentExec?.safeBinTrustedDirs ?? globalExec?.safeBinTrustedDirs,
    safeBinProfiles: resolveMergedSafeBinProfileFixtures({
      global: globalExec,
      local: agentExec,
    }),
    reviewer: agentExec?.reviewer ?? globalExec?.reviewer,
    backgroundMs: agentExec?.backgroundMs ?? globalExec?.backgroundMs,
    timeoutSec: agentExec?.timeoutSec ?? globalExec?.timeoutSec,
    approvalRunningNoticeMs:
      agentExec?.approvalRunningNoticeMs ?? globalExec?.approvalRunningNoticeMs,
    cleanupMs: agentExec?.cleanupMs ?? globalExec?.cleanupMs,
    notifyOnExit: agentExec?.notifyOnExit ?? globalExec?.notifyOnExit,
    notifyOnExitEmptySuccess:
      agentExec?.notifyOnExitEmptySuccess ?? globalExec?.notifyOnExitEmptySuccess,
    applyPatch: agentExec?.applyPatch ?? globalExec?.applyPatch,
  };
}
