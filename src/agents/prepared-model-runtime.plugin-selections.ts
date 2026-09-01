import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

/** Combines requested owners with facts derived from the committed config generation. */
export function getPreparedModelRuntimePluginSelections(
  input: Pick<PreparedModelRuntimeInput, "runtimePluginSelections" | "compactionPluginSelections">,
): PreparedModelRuntimeInput["runtimePluginSelections"] {
  if (!input.compactionPluginSelections?.length) {
    return input.runtimePluginSelections;
  }
  const selections = new Map(
    [...(input.runtimePluginSelections ?? []), ...input.compactionPluginSelections].map(
      (selection) =>
        [
          JSON.stringify([selection.provider, selection.modelId, selection.runtime]),
          selection,
        ] as const,
    ),
  );
  return Object.freeze(
    [...selections.values()].toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  );
}
