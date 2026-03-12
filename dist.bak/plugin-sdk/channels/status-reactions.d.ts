/**
 * Channel-agnostic status reaction controller.
 * Provides a unified interface for displaying agent status via message reactions.
 */
export type StatusReactionAdapter = {
    /** Set/replace the current reaction emoji. */
    setReaction: (emoji: string) => Promise<void>;
    /** Remove a specific reaction emoji (optional — needed for Discord-style platforms). */
    removeReaction?: (emoji: string) => Promise<void>;
};
export type StatusReactionEmojis = {
    queued?: string;
    thinking?: string;
    tool?: string;
    coding?: string;
    web?: string;
    done?: string;
    error?: string;
    stallSoft?: string;
    stallHard?: string;
};
export type StatusReactionTiming = {
    debounceMs?: number;
    stallSoftMs?: number;
    stallHardMs?: number;
    doneHoldMs?: number;
    errorHoldMs?: number;
};
export type StatusReactionController = {
    setQueued: () => Promise<void> | void;
    setThinking: () => Promise<void> | void;
    setTool: (toolName?: string) => Promise<void> | void;
    setDone: () => Promise<void>;
    setError: () => Promise<void>;
    clear: () => Promise<void>;
    restoreInitial: () => Promise<void>;
};
export declare const DEFAULT_EMOJIS: Required<StatusReactionEmojis>;
export declare const DEFAULT_TIMING: Required<StatusReactionTiming>;
export declare const CODING_TOOL_TOKENS: string[];
export declare const WEB_TOOL_TOKENS: string[];
/**
 * Resolve the appropriate emoji for a tool invocation.
 */
export declare function resolveToolEmoji(toolName: string | undefined, emojis: Required<StatusReactionEmojis>): string;
/**
 * Create a status reaction controller.
 *
 * Features:
 * - Promise chain serialization (prevents concurrent API calls)
 * - Debouncing (intermediate states debounce, terminal states are immediate)
 * - Stall timers (soft/hard warnings on inactivity)
 * - Terminal state protection (done/error mark finished, subsequent updates ignored)
 */
export declare function createStatusReactionController(params: {
    enabled: boolean;
    adapter: StatusReactionAdapter;
    initialEmoji: string;
    emojis?: StatusReactionEmojis;
    timing?: StatusReactionTiming;
    onError?: (err: unknown) => void;
}): StatusReactionController;
