import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
export declare function sanitizeDiscordFrontChannelText(text: string): string;
export declare function sanitizeDiscordFrontChannelReplyPayloads(payloads: readonly ReplyPayload[], options?: {
    kind?: "tool" | "block" | "final";
}): ReplyPayload[];
