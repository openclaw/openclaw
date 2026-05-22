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
export type ParsedChatAllowTarget = ParsedChatTarget | {
    kind: "handle";
    handle: string;
};
export type ChatSenderAllowParams = {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
};
export declare function isAllowedParsedChatSender(params: {
    allowFrom: Array<string | number>;
    sender: string;
    chatId?: number | null;
    chatGuid?: string | null;
    chatIdentifier?: string | null;
    normalizeSender: (sender: string) => string;
    parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean;
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
export declare function resolveServicePrefixedChatTarget<TService extends string, TTarget>(params: {
    trimmed: string;
    lower: string;
    servicePrefixes: Array<ServicePrefix<TService>>;
    chatIdPrefixes: string[];
    chatGuidPrefixes: string[];
    chatIdentifierPrefixes: string[];
    extraChatPrefixes?: string[];
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
export declare function resolveServicePrefixedOrChatAllowTarget<TAllowTarget extends ParsedChatAllowTarget>(params: {
    trimmed: string;
    lower: string;
    servicePrefixes: Array<{
        prefix: string;
    }>;
    parseAllowTarget: (remainder: string) => TAllowTarget;
    chatIdPrefixes: string[];
    chatGuidPrefixes: string[];
    chatIdentifierPrefixes: string[];
}): TAllowTarget | null;
export declare function createAllowedChatSenderMatcher(params: {
    normalizeSender: (sender: string) => string;
    parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): (input: ChatSenderAllowParams) => boolean;
export declare function parseChatAllowTargetPrefixes(params: ChatTargetPrefixesParams): ParsedChatTarget | null;
