import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { DedupConfig, RefTable } from "./deduper.js";
import type { LCSConfig } from "./lcs-dedup.js";

export type ContextDedupRuntimeValue = {
  settings: DedupConfig;
  lcsSettings?: LCSConfig;
  refTable: RefTable;
  refTagSize: number;
};

const registry = createSessionManagerRuntimeRegistry<ContextDedupRuntimeValue>();
export const setContextDedupRuntime = registry.set;
export const getContextDedupRuntime = registry.get;
