import { a as resolveServicePrefixedAllowTarget, c as resolveServicePrefixedTarget, i as parseChatTargetPrefixesOrThrow, o as resolveServicePrefixedChatTarget, r as parseChatAllowTargetPrefixes, s as resolveServicePrefixedOrChatAllowTarget, t as createAllowedChatSenderMatcher } from "../../chat-target-prefixes-DKnHakTu.js";
import { i as resolveIMessageAccount, n as listIMessageAccountIds, r as resolveDefaultIMessageAccountId, t as listEnabledIMessageAccounts } from "../../accounts-G6A_hywc.js";
import { n as IMESSAGE_ACTIONS, r as IMESSAGE_ACTION_NAMES } from "../../message-tool-api-D1iehFu5.js";
import { n as DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../../client-BcN4Qxqo.js";
import { a as looksLikeIMessageExplicitTargetId, c as parseIMessageTarget, i as isAllowedIMessageSender, n as inferIMessageTargetChatType, o as normalizeIMessageHandle, s as parseIMessageAllowTarget, t as formatIMessageChatTarget } from "../../targets-C7radLf6.js";
import { t as probeIMessage } from "../../probe-DlyCigli.js";
import { n as resolveIMessageGroupToolPolicy, t as resolveIMessageGroupRequireMention } from "../../group-policy-D47qAdAl.js";
import { a as resolveIMessageConversationIdFromTarget, i as normalizeIMessageAcpConversationId, n as resolveIMessageInboundConversationId, o as looksLikeIMessageTargetId, r as matchIMessageAcpConversation, s as normalizeIMessageMessagingTarget } from "../../sanitize-outbound-BQ1rwkeO.js";
import { n as testing, t as createIMessageConversationBindingManager } from "../../conversation-bindings-BReJ5mZb.js";
import { a as imessageSetupAdapter } from "../../setup-core-kMySWikj.js";
import { n as createIMessagePluginBase, r as imessageSetupWizard, t as imessagePlugin } from "../../channel-5qRvwiAV.js";
import { t as IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "../../outbound-send-deps-B-QEsLSM.js";
//#region extensions/imessage/src/channel.setup.ts
const imessageSetupPlugin = { ...createIMessagePluginBase({
	setupWizard: imessageSetupWizard,
	setup: imessageSetupAdapter
}) };
//#endregion
export { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS, IMESSAGE_ACTIONS, IMESSAGE_ACTION_NAMES, IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS, testing as __testing, testing, createAllowedChatSenderMatcher, createIMessageConversationBindingManager, formatIMessageChatTarget, imessagePlugin, imessageSetupPlugin, inferIMessageTargetChatType, isAllowedIMessageSender, listEnabledIMessageAccounts, listIMessageAccountIds, looksLikeIMessageExplicitTargetId, looksLikeIMessageTargetId, matchIMessageAcpConversation, normalizeIMessageAcpConversationId, normalizeIMessageHandle, normalizeIMessageMessagingTarget, parseChatAllowTargetPrefixes, parseChatTargetPrefixesOrThrow, parseIMessageAllowTarget, parseIMessageTarget, probeIMessage, resolveDefaultIMessageAccountId, resolveIMessageAccount, resolveIMessageConversationIdFromTarget, resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy, resolveIMessageInboundConversationId, resolveServicePrefixedAllowTarget, resolveServicePrefixedChatTarget, resolveServicePrefixedOrChatAllowTarget, resolveServicePrefixedTarget };
