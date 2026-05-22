export declare function resolveSlackAutoThreadId(params: {
    to: string;
    toolContext?: {
        currentChannelId?: string;
        currentThreadTs?: string;
        replyToMode?: "off" | "first" | "all" | "batched";
        hasRepliedRef?: {
            value: boolean;
        };
        sameChannelThreadRequired?: boolean;
    };
}): string | undefined;
