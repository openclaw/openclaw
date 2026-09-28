import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveProviderThinkingLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { findModelCatalogEntry } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";

function findCliCatalogEntry(params: {
  catalog: ModelCatalogEntry[];
  providers: string[];
  models: string[];
  requireContextWindows?: boolean;
}): ModelCatalogEntry | undefined {
  for (const provider of params.providers) {
    for (const model of params.models) {
      const entry = findModelCatalogEntry(params.catalog, { provider, modelId: model });
      if (entry && (!params.requireContextWindows || entry.contextWindows?.length)) {
        return entry;
      }
    }
  }
  return undefined;
}

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
  const query = {
    catalog: params.catalog,
    providers: uniqueStrings(
      [params.provider, params.modelProvider].filter((provider): provider is string =>
        Boolean(provider),
      ),
    ),
    models: uniqueStrings([params.modelId, params.normalizedModel]),
  };
  const thinkingEntry = findCliCatalogEntry(query);
  return {
    selectableContextEntry: findCliCatalogEntry({ ...query, requireContextWindows: true }),
    providerThinkingLevel: resolveProviderThinkingLevel({
      provider: thinkingEntry?.provider ?? params.modelProvider ?? params.provider,
      model: thinkingEntry?.id ?? params.normalizedModel,
      catalog: params.catalog,
      agentRuntime: params.agentRuntime,
      level: params.thinkLevel,
    }),
  };
}
