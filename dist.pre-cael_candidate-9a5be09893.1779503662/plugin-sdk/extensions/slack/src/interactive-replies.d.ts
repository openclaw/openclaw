import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
/**
 * @deprecated Only needed for legacy Slack reply directives. New producers should emit presentation payloads.
 */
export declare function isSlackInteractiveRepliesEnabled(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): boolean;
/**
 * @deprecated Slack reply directives are legacy. New producers should emit presentation payloads.
 */
export declare function compileSlackInteractiveReplies(payload: ReplyPayload): ReplyPayload;
/**
 * @deprecated Legacy Slack directive fallback. New producers should emit presentation payloads.
 */
export declare function parseSlackOptionsLine(payload: ReplyPayload): ReplyPayload;
