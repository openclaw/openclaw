export type ChannelSendRawResult = {
    ok: boolean;
    messageId?: string | null;
    error?: string | null;
};
export declare function buildChannelSendResult(channel: string, result: ChannelSendRawResult): {
    channel: string;
    ok: boolean;
    messageId: string;
    error: Error | undefined;
};
