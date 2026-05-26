import { H as ChannelTtsVoiceDeliveryCapabilities } from "./types.core-BkmTlRzr.js";
//#region src/channels/plugins/chat-target-prefixes.d.ts
type ServicePrefix<TService extends string> = {
  prefix: string;
  service: TService;
};
type ChatTargetPrefixesParams = {
  trimmed: string;
  lower: string;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
};
type ParsedChatTarget = {
  kind: "chat_id";
  chatId: number;
} | {
  kind: "chat_guid";
  chatGuid: string;
} | {
  kind: "chat_identifier";
  chatIdentifier: string;
};
type ParsedChatAllowTarget = ParsedChatTarget | {
  kind: "handle";
  handle: string;
};
type ChatSenderAllowParams = {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  allowConversationTargets?: boolean | null;
};
declare function resolveServicePrefixedTarget<TService extends string, TTarget>(params: {
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
declare function resolveServicePrefixedChatTarget<TService extends string, TTarget>(params: {
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
declare function parseChatTargetPrefixesOrThrow(params: ChatTargetPrefixesParams): ParsedChatTarget | null;
declare function resolveServicePrefixedAllowTarget<TAllowTarget>(params: {
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
declare function resolveServicePrefixedOrChatAllowTarget<TAllowTarget extends ParsedChatAllowTarget>(params: {
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
declare function createAllowedChatSenderMatcher(params: {
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
  allowConversationTargets?: boolean;
}): (input: ChatSenderAllowParams) => boolean;
declare function parseChatAllowTargetPrefixes(params: ChatTargetPrefixesParams): ParsedChatTarget | null;
//#endregion
//#region src/channels/plugins/tts-capabilities.d.ts
declare function resolveChannelTtsVoiceDelivery(channel: string | undefined): ChannelTtsVoiceDeliveryCapabilities | undefined;
//#endregion
export { ParsedChatTarget as a, parseChatAllowTargetPrefixes as c, resolveServicePrefixedChatTarget as d, resolveServicePrefixedOrChatAllowTarget as f, ParsedChatAllowTarget as i, parseChatTargetPrefixesOrThrow as l, ChatSenderAllowParams as n, ServicePrefix as o, resolveServicePrefixedTarget as p, ChatTargetPrefixesParams as r, createAllowedChatSenderMatcher as s, resolveChannelTtsVoiceDelivery as t, resolveServicePrefixedAllowTarget as u };