//#region src/infra/outbound/target-errors.d.ts
declare function missingTargetError(provider: string, hint?: string): Error;
//#endregion
//#region src/channels/status-reactions.d.ts
/**
 * Channel-agnostic status reaction controller.
 * Provides a unified interface for displaying agent status via message reactions.
 */
type StatusReactionAdapter = {
  /** Set/replace the current reaction emoji. */setReaction: (emoji: string) => Promise<void>; /** Remove a specific reaction emoji (optional — needed for Discord-style platforms). */
  removeReaction?: (emoji: string) => Promise<void>;
};
type StatusReactionEmojis = {
  queued?: string;
  thinking?: string;
  tool?: string;
  coding?: string;
  web?: string;
  done?: string;
  error?: string;
  stallSoft?: string;
  stallHard?: string;
  compacting?: string;
};
type StatusReactionTiming = {
  debounceMs?: number;
  stallSoftMs?: number;
  stallHardMs?: number;
  doneHoldMs?: number;
  errorHoldMs?: number;
};
type StatusReactionController = {
  setQueued: () => Promise<void> | void;
  setThinking: () => Promise<void> | void;
  setTool: (toolName?: string) => Promise<void> | void;
  setCompacting: () => Promise<void> | void; /** Cancel any pending debounced emoji (useful before forcing a state transition). */
  cancelPending: () => void;
  setDone: () => Promise<void>;
  setError: () => Promise<void>;
  clear: () => Promise<void>;
  restoreInitial: () => Promise<void>;
};
declare const DEFAULT_EMOJIS: Required<StatusReactionEmojis>;
declare const DEFAULT_TIMING: Required<StatusReactionTiming>;
declare const CODING_TOOL_TOKENS: string[];
declare const WEB_TOOL_TOKENS: string[];
/**
 * Resolve the appropriate emoji for a tool invocation.
 */
declare function resolveToolEmoji(toolName: string | undefined, emojis: Required<StatusReactionEmojis>, emojiOverrides?: StatusReactionEmojis): string;
/**
 * Create a status reaction controller.
 *
 * Features:
 * - Promise chain serialization (prevents concurrent API calls)
 * - Debouncing (intermediate states debounce, terminal states are immediate)
 * - Stall timers (soft/hard warnings on inactivity)
 * - Terminal state protection (done/error mark finished, subsequent updates ignored)
 * - Defers reaction removals until final cleanup to avoid visible flicker on
 *   platforms without atomic reaction replacement
 */
declare function createStatusReactionController(params: {
  enabled: boolean;
  adapter: StatusReactionAdapter;
  initialEmoji: string;
  emojis?: StatusReactionEmojis;
  timing?: StatusReactionTiming;
  onError?: (err: unknown) => void;
}): StatusReactionController;
//#endregion
export { StatusReactionController as a, WEB_TOOL_TOKENS as c, missingTargetError as d, StatusReactionAdapter as i, createStatusReactionController as l, DEFAULT_EMOJIS as n, StatusReactionEmojis as o, DEFAULT_TIMING as r, StatusReactionTiming as s, CODING_TOOL_TOKENS as t, resolveToolEmoji as u };