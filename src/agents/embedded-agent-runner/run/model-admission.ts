import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfigSnapshot } from "../../../config/config.js";
import { resolveSessionPinnedHarnessId } from "../../../sessions/agent-harness-session-key.js";
import {
  assertOperatorModelAllowed,
  readRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { resolveModelCandidateChain } from "../../model-fallback-candidates.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveInitialEmbeddedRunModel } from "./runtime-resolution.js";

export function resolveEmbeddedRunConfig(
  params: Pick<RunEmbeddedAgentParams, "config" | "provider" | "model">,
) {
  const requestedProvider = normalizeOptionalString(params.provider);
  const requestedModel = normalizeOptionalString(params.model);
  const needsConfiguredDefault = !params.config && !requestedProvider && !requestedModel;
  return (
    params.config ??
    (needsConfiguredDefault ? (getRuntimeConfigSnapshot() ?? undefined) : undefined)
  );
}

/** Native sessions attest their own model later; ordinary requests are checked before runtime preparation. */
export function assertInitialOperatorModelPolicy(
  params: Pick<
    RunEmbeddedAgentInternalParams,
    | "config"
    | "agentId"
    | "provider"
    | "model"
    | "requestedRouteResolution"
    | "pluginGeneration"
    | "preparedRunAdmission"
    | "admittedRunContext"
  >,
  entry: Parameters<typeof resolveSessionPinnedHarnessId>[0],
): void {
  const operatorAuthority = readRunOperatorAuthority(params);
  if (!operatorAuthority?.modelPolicy || resolveSessionPinnedHarnessId(entry)) {
    return;
  }
  const selection = resolveInitialEmbeddedRunModel({
    config: params.config,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
  });
  const selected = resolveModelCandidateChain({
    cfg: params.config,
    agentId: params.agentId,
    provider: selection.provider,
    model: selection.modelId,
    requestedRouteResolution: params.requestedRouteResolution,
    fallbacksOverride: [],
    manifestPlugins: params.pluginGeneration?.pluginMetadataSnapshot,
  })[0];
  assertOperatorModelAllowed(operatorAuthority, selected);
}
