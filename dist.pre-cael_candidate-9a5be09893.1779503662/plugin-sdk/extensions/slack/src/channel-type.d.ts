import type { OpenClawConfig } from "./runtime-api.js";
export type SlackConversationInfo = {
    type: "channel" | "group" | "dm" | "unknown";
    user?: string;
};
export declare function resolveSlackConversationInfo(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    channelId: string;
}): Promise<SlackConversationInfo>;
export declare function resolveSlackChannelType(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown">;
export declare function resetSlackChannelTypeCacheForTest(): void;
/** @deprecated Use `resetSlackChannelTypeCacheForTest`. */
export { resetSlackChannelTypeCacheForTest as __resetSlackChannelTypeCacheForTest };
