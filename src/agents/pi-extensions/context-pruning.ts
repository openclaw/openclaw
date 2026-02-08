/**
 * Opt-in context pruning (“microcompact”-style) for Pi sessions.
 *
 * This only affects the in-memory context for the current request; it does not rewrite session
 * history persisted on disk.
 */

export { default } from "./context-pruning/extension.js";

export { capToolResultMessages, pruneContextMessages } from "./context-pruning/pruner.js";
export type {
  ContextPruningConfig,
  ContextPruningToolMatch,
  EffectiveContextPruningSettings,
} from "./context-pruning/settings.js";
export {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
} from "./context-pruning/settings.js";
