type ReactionToolContext = {
    currentMessageId?: string | number;
};
export declare function resolveReactionMessageId(params: {
    args: Record<string, unknown>;
    toolContext?: ReactionToolContext;
}): string | number | undefined;
export {};
