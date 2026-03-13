import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
export type SlackMessageHandler = (message: SlackMessageEvent, opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
}) => Promise<void>;
/**
 * Build a debounce key that isolates messages by thread (or by message timestamp
 * for top-level non-DM channel messages). Without per-message scoping, concurrent
 * top-level messages from the same sender can share a key and get merged
 * into a single reply on the wrong thread.
 *
 * DMs intentionally stay channel-scoped to preserve short-message batching.
 */
export declare function buildSlackDebounceKey(message: SlackMessageEvent, accountId: string): string | null;
export declare function createSlackMessageHandler(params: {
    ctx: SlackMonitorContext;
    account: ResolvedSlackAccount;
    /** Called on each inbound event to update liveness tracking. */
    trackEvent?: () => void;
}): SlackMessageHandler;
