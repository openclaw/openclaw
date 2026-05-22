import type { SlackMonitorContext } from "../context.js";
type SlackAuthorizedSystemEventContext = {
    channelLabel: string;
    sessionKey: string;
};
export declare function authorizeAndResolveSlackSystemEventContext(params: {
    ctx: SlackMonitorContext;
    senderId?: string;
    channelId?: string;
    channelType?: string | null;
    eventKind: string;
}): Promise<SlackAuthorizedSystemEventContext | undefined>;
export {};
