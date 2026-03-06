export type ServicePrefix<TService extends string> = {
    prefix: string;
    service: TService;
};
export type ChatTargetPrefixesParams = {
    trimmed: string;
    lower: string;
    chatIdPrefixes: string[];
    chatGuidPrefixes: string[];
    chatIdentifierPrefixes: string[];
};
export type ParsedChatTarget = {
    kind: "chat_id";
    chatId: number;
} | {
    kind: "chat_guid";
    chatGuid: string;
} | {
    kind: "chat_identifier";
    chatIdentifier: string;
};
export declare function resolveServicePrefixedTarget<TService extends string, TTarget>(params: {
    trimmed: string;
    lower: string;
    servicePrefixes: Array<ServicePrefix<TService>>;
    isChatTarget: (remainderLower: string) => boolean;
    parseTarget: (remainder: string) => TTarget;
}): ({
    kind: "handle";
    to: string;
    service: TService;
} | TTarget) | null;
export declare function parseChatTargetPrefixesOrThrow(params: ChatTargetPrefixesParams): ParsedChatTarget | null;
export declare function resolveServicePrefixedAllowTarget<TAllowTarget>(params: {
    trimmed: string;
    lower: string;
    servicePrefixes: Array<{
        prefix: string;
    }>;
    parseAllowTarget: (remainder: string) => TAllowTarget;
}): (TAllowTarget | {
    kind: "handle";
    handle: string;
}) | null;
export declare function parseChatAllowTargetPrefixes(params: ChatTargetPrefixesParams): ParsedChatTarget | null;
