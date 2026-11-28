import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAgentDir, resolveNativeModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveModelRefWithConfiguredAliases } from "./model-selection-shared.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import type { AgentSimpleCompletionSelection } from "./simple-completion.types.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

export type SimpleCompletionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean | "required";
  manifestPlugins?:
    | PluginMetadataSnapshot["plugins"]
    | Pick<PluginMetadataSnapshot, "plugins" | "owners">;
};

export function resolveSimpleCompletionSelectionRequest(
  params: Omit<SimpleCompletionSelectionParams, "agentDir">,
): {
  selection: Omit<AgentSimpleCompletionSelection, "agentDir">;
  shorthandModelId?: string;
} | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  // Utility routing derives a provider-declared small model when unset and
  // optional routing treats an empty utilityModel as "use the primary" (disabled).
  const modelRef =
    params.modelRef?.trim() ||
    (params.useUtilityModel
      ? resolveUtilityModelRefForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          primaryProvider: fallbackRef?.provider,
          primaryModelId: fallbackRef?.model,
          ...(params.manifestPlugins
            ? {
                metadataSnapshot:
                  "plugins" in params.manifestPlugins
                    ? params.manifestPlugins
                    : { plugins: params.manifestPlugins },
              }
            : {}),
        })
      : undefined) ||
    (params.useUtilityModel === "required"
      ? undefined
      : resolveNativeModelPrimary(params.cfg, params.agentId));
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const resolved = split
    ? resolveModelRefWithConfiguredAliases({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: split.model,
        defaultProvider: fallbackRef?.provider ?? DEFAULT_PROVIDER,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  if (params.useUtilityModel === "required" && !resolved) {
    return null;
  }
  const provider = resolved?.ref.provider ?? fallbackRef?.provider;
  const modelId = resolved?.ref.model ?? fallbackRef?.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    selection: {
      provider,
      modelId,
      profileId: split?.profile || undefined,
    },
    ...(split && !split.model.includes("/") ? { shorthandModelId: split.model } : {}),
  };
}

export function resolveSimpleCompletionSelectionForAgent(
  params: SimpleCompletionSelectionParams,
): AgentSimpleCompletionSelection | null {
  const request = resolveSimpleCompletionSelectionRequest(params);
  return request
    ? {
        ...request.selection,
        agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, params.agentId),
      }
    : null;
}
