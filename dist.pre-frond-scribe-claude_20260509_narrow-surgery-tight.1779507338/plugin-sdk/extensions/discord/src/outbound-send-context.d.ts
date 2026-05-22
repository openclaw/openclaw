import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { type ReplyToResolution } from "openclaw/plugin-sdk/outbound-runtime";
import { type OutboundSendDeps } from "openclaw/plugin-sdk/outbound-send-deps";
type DiscordSendRuntime = typeof import("./send.js");
export type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
export type DiscordVoiceSendFn = DiscordSendRuntime["sendVoiceMessageDiscord"];
type DiscordFormattingOptions = {
    textLimit?: number;
    maxLinesPerMessage?: number;
    tableMode?: NonNullable<Parameters<DiscordSendFn>[2]>["tableMode"];
    chunkMode?: NonNullable<Parameters<DiscordSendFn>[2]>["chunkMode"];
};
export declare function loadDiscordSendRuntime(): Promise<DiscordSendRuntime>;
export declare function resolveDiscordOutboundTarget(params: {
    to: string;
    threadId?: string | number | null;
}): string;
export declare function resolveDiscordFormattingOptions(ctx: {
    formatting?: DiscordFormattingOptions;
}): DiscordFormattingOptions;
export declare function createDiscordPayloadSendContext(ctx: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    deps?: OutboundSendDeps;
    replyToId?: string | null;
    replyToIdSource?: ReplyToResolution["source"];
    replyToMode?: ReplyToMode;
    formatting?: DiscordFormattingOptions;
    threadId?: string | number | null;
}): Promise<{
    target: string;
    formatting: DiscordFormattingOptions;
    resolveReplyTo: () => string | undefined;
    send: DiscordSendFn;
    sendVoice: DiscordVoiceSendFn;
    withRetry: <T>(fn: () => Promise<T>) => Promise<T>;
}>;
export {};
