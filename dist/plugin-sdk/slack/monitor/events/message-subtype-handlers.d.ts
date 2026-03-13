import type { SlackMessageEvent } from "../../types.js";
type SupportedSubtype = "message_changed" | "message_deleted" | "thread_broadcast";
export type SlackMessageSubtypeHandler = {
    subtype: SupportedSubtype;
    eventKind: SupportedSubtype;
    describe: (channelLabel: string) => string;
    contextKey: (event: SlackMessageEvent) => string;
    resolveSenderId: (event: SlackMessageEvent) => string | undefined;
    resolveChannelId: (event: SlackMessageEvent) => string | undefined;
    resolveChannelType: (event: SlackMessageEvent) => string | null | undefined;
};
export declare function resolveSlackMessageSubtypeHandler(event: SlackMessageEvent): SlackMessageSubtypeHandler | undefined;
export {};
