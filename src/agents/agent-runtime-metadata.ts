/** Resolves agent runtime metadata from model/provider policy and ACP session overlays. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/availability.js";
import type { AgentRuntimePolicyScope } from "./model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  resolvePersistedSessionRuntimeId,
  resolveSessionRuntimeOverrideForProvider,
} from "./session-runtime-compat.js";

type AgentRuntimeMetadata = {
  id: string;
  source: "implicit" | "model" | "provider" | "session" | "session-key";
};

type ModelAgentRuntimeMetadataParams = {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionEntry?: Parameters<typeof resolvePersistedSessionRuntimeId>[0];
  /** True only when persisted ACP metadata owns the session. */
  acpRuntime?: boolean;
  /** Persisted ACP backend id, falling back to acpx when absent. */
  acpBackend?: string;
  agentHarnessRuntimeOverride?: string;
} & (
  | { agentId: string; agentScope?: never }
  | Extract<AgentRuntimePolicyScope, { agentScope: unknown }>
);

/** Resolves the runtime id/source that should be reported for a model-backed agent session. */
export function resolveModelAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  // Persisted ACP ownership is authoritative; configured policy cannot change it.
  if (params.acpRuntime === true) {
    return { id: params.acpBackend || "acpx", source: "session-key" };
  }
  const persistedRuntimeId = resolvePersistedSessionRuntimeId(params.sessionEntry);
  if (persistedRuntimeId && !isDefaultAgentRuntimeId(persistedRuntimeId)) {
    return { id: persistedRuntimeId, source: "session" };
  }
  const agentId = params.agentScope ? params.agentScope.agentId : params.agentId;
  const resolved =
    params.provider && params.model
      ? { provider: params.provider, model: params.model }
      : resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const policy = resolveAvailableAgentHarnessPolicy({
    ...params,
    mode: "projection",
    provider: resolved.provider,
    modelId: resolved.model,
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  });
  return {
    id: policy.runtime,
    source: policy.runtimeSource ?? "implicit",
  };
}

/** Resolves the runtime selected for the next turn, excluding historical producer metadata. */
export function resolveCurrentSessionAgentRuntimeMetadata(
  params: ModelAgentRuntimeMetadataParams,
): AgentRuntimeMetadata {
  if (params.acpRuntime) {
    return resolveModelAgentRuntimeMetadata(params);
  }
  const { sessionEntry, ...configuredParams } = params;
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: sessionEntry,
    cfg: params.cfg,
  });
  if (!sessionRuntime) {
    return resolveModelAgentRuntimeMetadata(configuredParams);
  }
  const runtime = resolveModelAgentRuntimeMetadata({
    ...configuredParams,
    ...(sessionEntry?.modelSelectionLocked === true
      ? { sessionEntry }
      : { agentHarnessRuntimeOverride: sessionRuntime }),
  });
  return {
    id: runtime.id,
    source: sessionEntry?.modelSelectionLocked === true ? "session" : "session-key",
  };
}
