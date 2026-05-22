import type { OpenClawConfig } from "../../config/types.js";
export interface TimestampInjectionOptions {
    timezone?: string;
    now?: Date;
}
/**
 * Injects a compact timestamp prefix into a message if one isn't already
 * present. Uses the same `YYYY-MM-DD HH:MM TZ` format as channel envelope
 * timestamps ({@link formatZonedTimestamp}), keeping token cost low (~7
 * tokens) and format consistent across all agent contexts.
 *
 * Used by the gateway `agent` and `chat.send` handlers to give TUI, web,
 * spawned subagents, `sessions_send`, and heartbeat wake events date/time
 * awareness — without modifying the system prompt (which is cached).
 *
 * Channel messages (Discord, Telegram, etc.) already have timestamps via
 * envelope formatting and take a separate code path — they never reach
 * these handlers, so there is no double-stamping risk. The detection
 * pattern is a safety net for edge cases.
 *
 * @see https://github.com/openclaw/openclaw/issues/3658
 */
export declare function injectTimestamp(message: string, opts?: TimestampInjectionOptions): string;
/**
 * Build TimestampInjectionOptions from an OpenClawConfig.
 */
export declare function timestampOptsFromConfig(cfg: OpenClawConfig): TimestampInjectionOptions;
