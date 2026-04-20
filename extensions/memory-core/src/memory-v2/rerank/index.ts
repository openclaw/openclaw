export { loadSidecarSignalsByLocations } from "./lookup.js";
export { applyRerank, mergeDefaults, recencyMultiplier, rescore } from "./score.js";
export {
  type RerankConfig,
  type RerankContext,
  type RerankFn,
  type RerankSignals,
  type RerankableResult,
  RERANK_DEFAULTS,
} from "./types.js";
export { type RerankWiringDeps, type RerankWrapperOptions, buildRerankWrapper } from "./wrapper.js";
