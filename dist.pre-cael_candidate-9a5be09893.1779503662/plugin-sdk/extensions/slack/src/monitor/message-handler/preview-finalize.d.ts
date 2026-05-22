import type { Block, KnownBlock, WebClient } from "@slack/web-api";
type SlackReadbackMessage = {
    ts?: string;
    text?: string;
    blocks?: unknown[];
};
declare function buildExpectedSlackEditText(params: {
    text: string;
    blocks?: (Block | KnownBlock)[];
}): string;
declare function blocksMatch(expected?: (Block | KnownBlock)[], actual?: unknown[]): boolean;
declare function readSlackMessageAfterEditError(params: {
    client: WebClient;
    token: string;
    channelId: string;
    messageId: string;
    threadTs?: string;
}): Promise<SlackReadbackMessage | null>;
declare function didSlackPreviewEditApplyAfterError(params: {
    client: WebClient;
    token: string;
    channelId: string;
    messageId: string;
    text: string;
    blocks?: (Block | KnownBlock)[];
    threadTs?: string;
}): Promise<boolean>;
export declare function finalizeSlackPreviewEdit(params: {
    client: WebClient;
    token: string;
    accountId?: string;
    channelId: string;
    messageId: string;
    text: string;
    blocks?: (Block | KnownBlock)[];
    threadTs?: string;
}): Promise<void>;
export declare const testing: {
    buildExpectedSlackEditText: typeof buildExpectedSlackEditText;
    blocksMatch: typeof blocksMatch;
    didSlackPreviewEditApplyAfterError: typeof didSlackPreviewEditApplyAfterError;
    readSlackMessageAfterEditError: typeof readSlackMessageAfterEditError;
};
export { testing as __testing };
