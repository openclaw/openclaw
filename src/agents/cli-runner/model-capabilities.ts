import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { findModelCatalogEntry } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import type { RunCliAgentParams } from "./types.js";

/** Selects both CLI capabilities from the same logical/native catalog identity. */
export function resolveCliCatalogCapabilities(params: {
  catalog: ModelCatalogEntry[];
  provider: string;
  modelProvider?: string;
  modelId: string;
  normalizedModel: string;
  agentRuntime: string;
  thinkLevel?: ThinkLevel;
}) {
  const providers = uniqueStrings(
    [params.provider, params.modelProvider].filter((provider): provider is string =>
      Boolean(provider),
    ),
  );
  const models = uniqueStrings([params.modelId, params.normalizedModel]);
  let thinkingEntry: ModelCatalogEntry | undefined;
  let selectableContextEntry: ModelCatalogEntry | undefined;
  for (const provider of providers) {
    for (const modelId of models) {
      const entry = findModelCatalogEntry(params.catalog, { provider, modelId });
      thinkingEntry ??= entry;
      if (entry?.contextWindows?.length) {
        selectableContextEntry = entry;
        break;
      }
    }
    if (selectableContextEntry) {
      break;
    }
  }
  return {
    selectableContextEntry,
    providerThinkingLevel: resolveProviderThinkingLevel({
      provider: thinkingEntry?.provider ?? params.modelProvider ?? params.provider,
      model: thinkingEntry?.id ?? params.normalizedModel,
      catalog: params.catalog,
      agentRuntime: params.agentRuntime,
      level: params.thinkLevel,
    }),
  };
}

export function resolveCliModelContextTokens(
  params: Pick<
    RunCliAgentParams,
    "config" | "provider" | "modelContextWindow" | "modelContextWindowSource" | "modelContextTokens"
  > & {
    modelIds: string[];
    modelProvider?: string;
    nativeRuntime: string;
  },
): number {
  const candidates = params.modelIds
    .map((model) =>
      resolveContextTokensForModel({
        cfg: params.config,
        provider: params.provider,
        modelProvider: params.modelProvider,
        model,
        nativeRuntime: params.nativeRuntime,
        modelContextWindow: params.modelContextWindow,
        modelContextWindowSource: params.modelContextWindowSource,
        modelContextTokens: params.modelContextTokens,
        allowAsyncLoad: false,
        allowUnscopedModelLookup: false,
      }),
    )
    .filter((tokens) => tokens !== undefined);
  return candidates.length ? Math.min(...candidates) : DEFAULT_CONTEXT_TOKENS;
}
