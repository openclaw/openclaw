import { n as ChannelPlugin } from "../../types.public-B2Ho5PN_.js";
import { a as ParsedChatTarget, c as parseChatAllowTargetPrefixes, d as resolveServicePrefixedChatTarget, f as resolveServicePrefixedOrChatAllowTarget, i as ParsedChatAllowTarget, l as parseChatTargetPrefixesOrThrow, n as ChatSenderAllowParams, o as ServicePrefix, p as resolveServicePrefixedTarget, r as ChatTargetPrefixesParams, s as createAllowedChatSenderMatcher, u as resolveServicePrefixedAllowTarget } from "../../channel-targets-DVKc1lQ7.js";
import { a as looksLikeIMessageTargetId, c as listEnabledIMessageAccounts, d as resolveIMessageAccount, i as DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS, l as listIMessageAccountIds, n as IMessageProbeOptions, o as normalizeIMessageMessagingTarget, r as probeIMessage, s as ResolvedIMessageAccount, t as IMessageProbe, u as resolveDefaultIMessageAccountId } from "../../probe-B8VUPhwi.js";
import { t as imessagePlugin } from "../../channel-B2iIlAL4.js";
import { n as testing, t as createIMessageConversationBindingManager } from "../../conversation-bindings-DQk5WRRT.js";
import { a as inferIMessageTargetChatType, c as normalizeIMessageHandle, d as resolveIMessageGroupRequireMention, f as resolveIMessageGroupToolPolicy, i as formatIMessageChatTarget, l as parseIMessageAllowTarget, n as IMessageService, o as isAllowedIMessageSender, r as IMessageTarget, s as looksLikeIMessageExplicitTargetId, t as IMessageAllowTarget, u as parseIMessageTarget } from "../../targets-C4Qlt7z3.js";

//#region extensions/imessage/src/channel.setup.d.ts
declare const imessageSetupPlugin: ChannelPlugin<ResolvedIMessageAccount>;
//#endregion
//#region extensions/imessage/src/conversation-id-core.d.ts
declare function normalizeIMessageAcpConversationId(conversationId: string): {
  conversationId: string;
} | null;
declare function matchIMessageAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): {
  conversationId: string;
  matchPriority: number;
} | null;
declare function resolveIMessageConversationIdFromTarget(target: string): string | undefined;
//#endregion
//#region extensions/imessage/src/conversation-id.d.ts
declare function resolveIMessageInboundConversationId(params: {
  isGroup: boolean;
  sender: string;
  chatId?: number;
}): string | undefined;
//#endregion
//#region extensions/imessage/src/outbound-send-deps.d.ts
declare const IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS: readonly ["sendIMessage"];
//#endregion
//#region extensions/imessage/src/actions-contract.d.ts
declare const IMESSAGE_ACTIONS: {
  readonly react: {
    readonly gate: "reactions";
  };
  readonly edit: {
    readonly gate: "edit";
  };
  readonly unsend: {
    readonly gate: "unsend";
  };
  readonly reply: {
    readonly gate: "reply";
  };
  readonly sendWithEffect: {
    readonly gate: "sendWithEffect";
  };
  readonly renameGroup: {
    readonly gate: "renameGroup";
    readonly groupOnly: true;
  };
  readonly setGroupIcon: {
    readonly gate: "setGroupIcon";
    readonly groupOnly: true;
  };
  readonly addParticipant: {
    readonly gate: "addParticipant";
    readonly groupOnly: true;
  };
  readonly removeParticipant: {
    readonly gate: "removeParticipant";
    readonly groupOnly: true;
  };
  readonly leaveGroup: {
    readonly gate: "leaveGroup";
    readonly groupOnly: true;
  };
  readonly sendAttachment: {
    readonly gate: "sendAttachment";
  };
};
type IMessageActionSpecs = typeof IMESSAGE_ACTIONS;
declare const IMESSAGE_ACTION_NAMES: Array<keyof IMessageActionSpecs>;
//#endregion
export { type ChatSenderAllowParams, type ChatTargetPrefixesParams, DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS, IMESSAGE_ACTIONS, IMESSAGE_ACTION_NAMES, IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS, type IMessageAllowTarget, type IMessageProbe, type IMessageProbeOptions, type IMessageService, type IMessageTarget, type ParsedChatAllowTarget, type ParsedChatTarget, type ResolvedIMessageAccount, type ServicePrefix, testing as __testing, testing, createAllowedChatSenderMatcher, createIMessageConversationBindingManager, formatIMessageChatTarget, imessagePlugin, imessageSetupPlugin, inferIMessageTargetChatType, isAllowedIMessageSender, listEnabledIMessageAccounts, listIMessageAccountIds, looksLikeIMessageExplicitTargetId, looksLikeIMessageTargetId, matchIMessageAcpConversation, normalizeIMessageAcpConversationId, normalizeIMessageHandle, normalizeIMessageMessagingTarget, parseChatAllowTargetPrefixes, parseChatTargetPrefixesOrThrow, parseIMessageAllowTarget, parseIMessageTarget, probeIMessage, resolveDefaultIMessageAccountId, resolveIMessageAccount, resolveIMessageConversationIdFromTarget, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, resolveIMessageInboundConversationId, resolveServicePrefixedAllowTarget, resolveServicePrefixedChatTarget, resolveServicePrefixedOrChatAllowTarget, resolveServicePrefixedTarget };