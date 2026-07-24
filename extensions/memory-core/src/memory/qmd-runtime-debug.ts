import type { MemorySearchRuntimeDebug } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type QmdCollectionValidationDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["collectionValidation"]
>;
type QmdMultiCollectionProbeDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["multiCollectionProbe"]
>;
type QmdSearchPlanDebug = NonNullable<NonNullable<MemorySearchRuntimeDebug["qmd"]>["searchPlan"]>;
type QmdMcporterCallPlanDebug = NonNullable<
  NonNullable<MemorySearchRuntimeDebug["qmd"]>["mcporterCallPlan"]
>;
export type QmdSearchRuntimeDebugContext = {
  collectionValidation?: QmdCollectionValidationDebug;
  multiCollectionProbe?: QmdMultiCollectionProbeDebug;
  searchPlan?: QmdSearchPlanDebug;
  mcporterCallPlan?: QmdMcporterCallPlanDebug;
  dirtySyncWaitMs?: number;
  pendingUpdateWaitMs?: number;
  collectionQueryMs?: number;
  resultResolutionMs?: number;
  hitsDroppedAtDocResolution?: number;
};
