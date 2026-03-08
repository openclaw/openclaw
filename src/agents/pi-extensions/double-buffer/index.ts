/**
 * Double-buffered context window extension.
 *
 * Implements background-summarize-then-swap to minimize agent downtime
 * during context-window hops.
 */

export { default } from "./extension.js";

export { BufferManager, buildSummarizeDep } from "./buffer-manager.js";
export type {
  BufferManagerDeps,
  BufferManagerSnapshot,
  BufferState,
  SummaryChain,
} from "./buffer-manager.js";

export { setDoubleBufferRuntime, getDoubleBufferRuntime } from "./runtime.js";
export type { DoubleBufferRuntimeValue } from "./runtime.js";

export type { DoubleBufferConfig, EffectiveDoubleBufferSettings } from "./settings.js";
export {
  computeEffectiveDoubleBufferSettings,
  DEFAULT_DOUBLE_BUFFER_SETTINGS,
} from "./settings.js";
