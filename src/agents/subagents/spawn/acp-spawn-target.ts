import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentIdStrict, normalizeOptionalAgentId } from "../../../routing/session-key.js";
import { resolveAgentEntry } from "../../agent-scope-config.js";

type ResolvedAcpAgentTarget = {
  ok: true;
  agentId: string;
  configAgentId?: string;
  backendId?: string;
};

function resolveAcpAgentTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  configAgentId?: string;
  agentBackend?: string;
}): ResolvedAcpAgentTarget {
  const backendId =
    normalizeOptionalString(params.agentBackend) ??
    normalizeOptionalString(params.cfg.acp?.backend) ??
    getAcpRuntimeBackend()?.id;
  return {
    ok: true,
    agentId: params.agentId,
    ...(params.configAgentId ? { configAgentId: params.configAgentId } : {}),
    ...(backendId ? { backendId } : {}),
  };
}

export function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): ResolvedAcpAgentTarget | { ok: false; error: string } {
  const normalizedRequest =
    params.requestedAgentId === undefined ? null : normalizeAgentIdStrict(params.requestedAgentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return { ok: false, error: `agentId "${params.requestedAgentId}" was not found` };
  }
  const requested =
    normalizedRequest?.value ?? normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (requested) {
    const configuredAgent = resolveAgentEntry(params.cfg, requested);
    if (configuredAgent?.runtime?.type === "acp") {
      return resolveAcpAgentTarget({
        cfg: params.cfg,
        agentId: normalizeOptionalAgentId(configuredAgent.runtime.acp?.agent) ?? requested,
        configAgentId: requested,
        agentBackend: configuredAgent.runtime.acp?.backend,
      });
    }
    if (configuredAgent && !isExplicitlyAllowedAcpAgent(params.cfg, requested)) {
      return {
        ok: false,
        error:
          `agentId "${requested}" is an OpenClaw config agent, not an ACP harness. ` +
          'Use runtime="subagent" or omit runtime for OpenClaw config agents. ' +
          'Use runtime="acp" only with external ACP harness ids such as codex, claude, droid, gemini, or opencode, or configure agents.entries.*.runtime.type="acp" with runtime.acp.agent.',
      };
    }
    return resolveAcpAgentTarget({
      cfg: params.cfg,
      agentId: requested,
      ...(configuredAgent ? { configAgentId: requested } : {}),
    });
  }

  return {
    ok: false,
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function isExplicitlyAllowedAcpAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return (cfg.acp?.allowedAgents ?? []).some(
    (entry) => entry.trim() === "*" || normalizeOptionalAgentId(entry) === agentId,
  );
}
