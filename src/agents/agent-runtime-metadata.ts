import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyAcpRuntimeOverlay } from "./acp-runtime-overlay.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

export type AgentRuntimeMetadata = {
  id: string;
  source: "implicit" | "model" | "provider" | "session-key";
};

export function resolveAgentRuntimeMetadata(
  _cfg: OpenClawConfig,
  _agentId: string,
  _env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeMetadata {
  return {
    id: "auto",
    source: "implicit",
  };
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
