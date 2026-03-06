import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { sendMessageSlack } from "./send.js";
export type SlackDraftStream = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    clear: () => Promise<void>;
    stop: () => void;
    forceNewMessage: () => void;
    messageId: () => string | undefined;
    channelId: () => string | undefined;
};
export declare function createSlackDraftStream(params: {
    target: string;
    token: string;
    accountId?: string;
    maxChars?: number;
    throttleMs?: number;
    resolveThreadTs?: () => string | undefined;
    onMessageSent?: () => void;
    log?: (message: string) => void;
    warn?: (message: string) => void;
    send?: typeof sendMessageSlack;
    edit?: typeof editSlackMessage;
    remove?: typeof deleteSlackMessage;
}): SlackDraftStream;
