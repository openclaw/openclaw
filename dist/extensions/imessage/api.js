import { a as resolveServicePrefixedAllowTarget, c as resolveServicePrefixedTarget, i as parseChatTargetPrefixesOrThrow, o as resolveServicePrefixedChatTarget, r as parseChatAllowTargetPrefixes, s as resolveServicePrefixedOrChatAllowTarget, t as createAllowedChatSenderMatcher } from "../../chat-target-prefixes-Dg6BOSOC.js";
import { i as resolveIMessageAccount, n as listIMessageAccountIds, r as resolveDefaultIMessageAccountId, t as listEnabledIMessageAccounts } from "../../accounts-DwISomWw.js";
import { n as IMESSAGE_ACTIONS, r as IMESSAGE_ACTION_NAMES } from "../../message-tool-api-D98iCkNy.js";
import { n as DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../../client-CLJO-5AX.js";
import { a as normalizeIMessageHandle, i as looksLikeIMessageExplicitTargetId, n as inferIMessageTargetChatType, o as parseIMessageAllowTarget, r as isAllowedIMessageSender, s as parseIMessageTarget, t as formatIMessageChatTarget } from "../../targets-C6d5PYq2.js";
import { t as probeIMessage } from "../../probe-4JZGtekU.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-DWbsvBO9.js";
import { a as resolveIMessageConversationIdFromTarget, i as normalizeIMessageAcpConversationId, n as resolveIMessageInboundConversationId, o as looksLikeIMessageTargetId, r as matchIMessageAcpConversation, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-B-2kV4-Q.js";
import { n as createIMessageConversationBindingManager, t as __testing } from "../../conversation-bindings-CcXxlG5H.js";
import { a as imessageSetupAdapter } from "../../setup-core-B-N4pXTa.js";
import { n as createIMessagePluginBase, r as imessageSetupWizard, t as imessagePlugin } from "../../channel-Dr9xdXql.js";
import { t as IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "../../outbound-send-deps-Bi6RRqsZ.js";
//#region extensions/imessage/src/channel.setup.ts
const imessageSetupPlugin = { ...createIMessagePluginBase({
	setupWizard: imessageSetupWizard,
	setup: imessageSetupAdapter
}) };
//#endregion
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS, IMESSAGE_ACTIONS, IMESSAGE_ACTION_NAMES, IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS, __testing, createAllowedChatSenderMatcher, createIMessageConversationBindingManager, formatIMessageChatTarget, imessagePlugin, imessageSetupPlugin, inferIMessageTargetChatType, isAllowedIMessageSender, listEnabledIMessageAccounts, listIMessageAccountIds, looksLikeIMessageExplicitTargetId, looksLikeIMessageTargetId, matchIMessageAcpConversation, normalizeIMessageAcpConversationId, normalizeIMessageHandle, normalizeIMessageMessagingTarget, parseChatAllowTargetPrefixes, parseChatTargetPrefixesOrThrow, parseIMessageAllowTarget, parseIMessageTarget, probeIMessage, resolveDefaultIMessageAccountId, resolveIMessageAccount, resolveIMessageConversationIdFromTarget, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, resolveIMessageInboundConversationId, resolveServicePrefixedAllowTarget, resolveServicePrefixedChatTarget, resolveServicePrefixedOrChatAllowTarget, resolveServicePrefixedTarget };
