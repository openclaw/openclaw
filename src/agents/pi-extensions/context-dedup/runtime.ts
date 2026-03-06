import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { DedupConfig } from "./deduper.js";

export type ContextDedupRuntimeValue = {
  settings: DedupConfig;
};

const registry = createSessionManagerRuntimeRegistry<ContextDedupRuntimeValue>();
export const setContextDedupRuntime = registry.set;
export const getContextDedupRuntime = registry.get;
