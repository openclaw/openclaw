import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAgentDir, resolveNativeModelPrimary } from "./agent-scope.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { AgentSimpleCompletionSelection } from "./simple-completion.types.js";
import { resolveUtilityModelRefForAgent } from "./utility-model.js";

export type SimpleCompletionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  manifestPlugins?:
    | PluginMetadataSnapshot["plugins"]
    | Pick<PluginMetadataSnapshot, "plugins" | "owners">;
};

type SimpleCompletionSelectionRequest = {
  selection: AgentSimpleCompletionSelection;
  shorthandModelId?: string;
};

export function resolveSimpleCompletionSelectionRequest(
  params: SimpleCompletionSelectionParams,
): SimpleCompletionSelectionRequest | null {
  const fallbackRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  // Utility routing derives a provider-declared small model when unset and
  // treats an explicit empty utilityModel as "use the primary" (disabled).
  const modelRef =
    params.modelRef?.trim() ||
    (params.useUtilityModel
      ? resolveUtilityModelRefForAgent({
          cfg: params.cfg,
          agentId: params.agentId,
          primaryProvider: fallbackRef.provider,
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
    resolveNativeModelPrimary(params.cfg, params.agentId);
  const split = modelRef ? splitTrailingAuthProfile(modelRef) : null;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    agentId: params.agentId,
    defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
    manifestPlugins: params.manifestPlugins,
  });
  const resolved = split
    ? resolveModelRefFromString({
        cfg: params.cfg,
        agentId: params.agentId,
        raw: split.model,
        defaultProvider: fallbackRef.provider || DEFAULT_PROVIDER,
        aliasIndex,
        manifestPlugins: params.manifestPlugins,
      })
    : null;
  const provider = resolved?.ref.provider ?? fallbackRef.provider;
  const modelId = resolved?.ref.model ?? fallbackRef.model;
  if (!provider || !modelId) {
    return null;
  }
  return {
    selection: {
      provider,
      modelId,
      profileId: split?.profile || undefined,
      agentDir: params.agentDir?.trim() || resolveAgentDir(params.cfg, params.agentId),
    },
    ...(split && !split.model.includes("/") ? { shorthandModelId: split.model } : {}),
  };
}

export function resolveSimpleCompletionSelectionForAgent(
  params: SimpleCompletionSelectionParams,
): AgentSimpleCompletionSelection | null {
  return resolveSimpleCompletionSelectionRequest(params)?.selection ?? null;
}
