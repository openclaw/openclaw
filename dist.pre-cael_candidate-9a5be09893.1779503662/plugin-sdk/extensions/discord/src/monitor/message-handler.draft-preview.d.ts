import { type ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-streaming";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { chunkDiscordTextWithMode } from "../chunk.js";
import type { RequestClient } from "../internal/discord.js";
type DraftReplyReference = {
    peek: () => string | undefined;
};
type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export declare function createDiscordDraftPreviewController(params: {
    cfg: OpenClawConfig;
    discordConfig: DiscordConfig;
    accountId: string;
    sourceRepliesAreToolOnly: boolean;
    textLimit: number;
    deliveryRest: RequestClient;
    deliverChannelId: string;
    replyReference: DraftReplyReference;
    tableMode: Parameters<typeof convertMarkdownTables>[1];
    maxLinesPerMessage: number | undefined;
    chunkMode: Parameters<typeof chunkDiscordTextWithMode>[1]["chunkMode"];
    log: (message: string) => void;
}): {
    draftStream: {
        update: (text: string) => void;
        flush: () => Promise<void>;
        messageId: () => string | undefined;
        clear: () => Promise<void>;
        discardPending: () => Promise<void>;
        seal: () => Promise<void>;
        stop: () => Promise<void>;
        forceNewMessage: () => void;
    } | undefined;
    previewToolProgressEnabled: boolean;
    suppressDefaultToolProgressMessages: boolean;
    readonly isProgressMode: boolean;
    readonly hasProgressDraftStarted: boolean;
    readonly finalizedViaPreviewMessage: boolean;
    markFinalReplyStarted(): void;
    markFinalReplyDelivered(): void;
    markPreviewFinalized(): void;
    disableBlockStreamingForDraft: boolean | undefined;
    startProgressDraft(): Promise<void>;
    pushToolProgress(line?: string | ChannelProgressDraftLine, options?: {
        toolName?: string;
    }): Promise<void>;
    pushReasoningProgress(text?: string): Promise<void>;
    resolvePreviewFinalText(text?: string): string | undefined;
    updateFromPartial(text?: string): void;
    handleAssistantMessageBoundary(): void;
    flush(): Promise<void>;
    cleanup(): Promise<void>;
};
export {};
