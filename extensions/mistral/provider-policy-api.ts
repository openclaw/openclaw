import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";
export const MISTRAL_SMALL_4_ID = "mistral-small-2603";
export const MISTRAL_MEDIUM_3_5_ID = "mistral-medium-3-5";

// A reasoning row maps each thinking level to its `reasoning_effort`. Rows offer `adaptive`
// through `compat.adaptiveThinking`, and Mistral serves it as `high`.
const REASONING_EFFORT_MAPS: ReadonlyMap<string, Record<string, string>> = new Map(
  manifest.modelCatalog.providers.mistral.models.flatMap((row) => {
    if (!row.thinkingLevelMap) {
      return [];
    }
    const { max, ...levels } = row.thinkingLevelMap;
    return [[row.id, { ...levels, adaptive: "high", max }]];
  }),
);

export function resolveMistralReasoningEffortMap(
  modelId: string | undefined,
): Record<string, string> | undefined {
  return modelId === undefined ? undefined : REASONING_EFFORT_MAPS.get(modelId);
}
