import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { applyAcpRuntimeOverlay } from "./acp-runtime-overlay.js";
import { listAgentEntries } from "./agent-scope-config.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";

export type AgentRuntimeMetadata = {
  id: string;
  source: "env" | "agent" | "defaults" | "implicit" | "model" | "provider" | "session-key";
};

function normalizeRuntimeValue(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  return normalized ? normalizeEmbeddedAgentRuntime(normalized) : undefined;
}

function resolveAgentEntryRuntimePolicy(
  cfg: OpenClawConfig,
  agentId: string,
): AgentRuntimePolicyConfig | undefined {
  const normalizedId = normalizeAgentId(agentId);
  const entry = listAgentEntries(cfg).find((e) => normalizeAgentId(e.id) === normalizedId);
  const policy = entry?.agentRuntime;
  return policy?.id?.trim() ? policy : undefined;
}

function resolveDefaultsRuntimePolicy(cfg: OpenClawConfig): AgentRuntimePolicyConfig | undefined {
  const policy = cfg.agents?.defaults?.agentRuntime;
  return policy?.id?.trim() ? policy : undefined;
}

/**
 * Resolve agent runtime metadata from agent-config policy sources (env, per-agent
 * config, defaults).  When `sessionKey` is provided the result is further patched
 * by `applyAcpRuntimeOverlay` so ACP sessions are never mislabelled as "pi".
 */
export function resolveAgentRuntimeMetadata(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  sessionKey?: string,
): AgentRuntimeMetadata {
  const envRuntime = normalizeRuntimeValue(env.OPENCLAW_AGENT_RUNTIME);
  if (envRuntime) {
    return applyAcpRuntimeOverlay({ id: envRuntime, source: "env" }, sessionKey);
  }

  const agentPolicy = resolveAgentEntryRuntimePolicy(cfg, agentId);
  const agentRuntime = normalizeRuntimeValue(agentPolicy?.id);
  if (agentRuntime) {
    return applyAcpRuntimeOverlay({ id: agentRuntime, source: "agent" }, sessionKey);
  }

  const defaultsPolicy = resolveDefaultsRuntimePolicy(cfg);
  const defaultsRuntime = normalizeRuntimeValue(defaultsPolicy?.id);
  if (defaultsRuntime) {
    return applyAcpRuntimeOverlay({ id: defaultsRuntime, source: "defaults" }, sessionKey);
  }

  return applyAcpRuntimeOverlay({ id: "pi", source: "implicit" }, sessionKey);
}

export function resolveModelAgentRuntimeMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
}): AgentRuntimeMetadata {
  const resolved =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const policy = resolveAgentHarnessPolicy({
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const meta: AgentRuntimeMetadata = {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
  return applyAcpRuntimeOverlay(meta, params.sessionKey);
}
