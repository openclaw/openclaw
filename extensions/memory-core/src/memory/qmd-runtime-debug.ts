import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type QmdCollectionValidationDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["collectionValidation"]
>;
export type QmdMultiCollectionProbeDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["multiCollectionProbe"]
>;
export type QmdSearchPlanDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["searchPlan"]
>;
export type QmdSearchRuntimeDebugContext = {
  collectionValidation?: QmdCollectionValidationDebug;
  multiCollectionProbe?: QmdMultiCollectionProbeDebug;
  searchPlan?: QmdSearchPlanDebug;
};
