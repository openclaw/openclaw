import type { MessageMetadata } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import type { SlackSendIdentity } from "./send.js";
import { sendMessageSlack } from "./send.js";
type SlackDraftStream = {
    update: (update: SlackDraftStreamUpdate) => void;
    flush: () => Promise<void>;
    clear: () => Promise<void>;
    discardPending: () => Promise<void>;
    seal: () => Promise<void>;
    stop: () => void;
    forceNewMessage: () => void;
    messageId: () => string | undefined;
    channelId: () => string | undefined;
};
export type SlackDraftStreamUpdate = string | {
    text: string;
    blocks?: (Block | KnownBlock)[];
};
export declare function createSlackDraftStream(params: {
    target: string;
    cfg: OpenClawConfig;
    token: string;
    accountId?: string;
    identity?: SlackSendIdentity;
    maxChars?: number;
    throttleMs?: number;
    resolveThreadTs?: () => string | undefined;
    metadata?: MessageMetadata;
    onMessageSent?: () => void;
    log?: (message: string) => void;
    warn?: (message: string) => void;
    send?: typeof sendMessageSlack;
    edit?: typeof editSlackMessage;
    remove?: typeof deleteSlackMessage;
}): SlackDraftStream;
export {};
