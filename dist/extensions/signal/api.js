import { i as resolveSignalAccount, n as listSignalAccountIds, r as resolveDefaultSignalAccountId, t as listEnabledSignalAccounts } from "../../accounts-1GlRRBqz.js";
import { a as normalizeSignalAllowRecipient, c as resolveSignalSender, d as normalizeSignalMessagingTarget, i as isSignalSenderAllowed, l as looksLikeUuid, n as formatSignalSenderDisplay, o as resolveSignalPeerId, r as formatSignalSenderId, s as resolveSignalRecipient, t as formatSignalPairingIdLine, u as looksLikeSignalTargetId } from "../../identity-BtCkAf6q.js";
import { i as resolveSignalOutboundTarget, n as createSignalPluginBase, r as signalSetupWizard, t as signalPlugin } from "../../channel-DRYlPKVK.js";
import { n as markdownToSignalTextChunks, t as markdownToSignalText } from "../../format-D1456gkg.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "../../reaction-runtime-api-Zdzq5Ojv.js";
import { n as resolveSignalReactionLevel, t as signalMessageActions } from "../../message-actions-HzkMqDqD.js";
import { r as normalizeSignalAccountInput, s as signalSetupAdapter } from "../../setup-core-tQ7IENke.js";
import { a as looksLikeArchive, n as extractSignalCliArchive, o as pickAsset, r as installSignalCli } from "../../install-signal-cli-DRg3mN1j.js";
import { t as monitorSignalProvider } from "../../monitor-FGgnsTZf.js";
import { n as sendReadReceiptSignal, r as sendTypingSignal, t as sendMessageSignal } from "../../send-DWcqjk0T.js";
import { t as probeSignal } from "../../probe-DENyGr9W.js";
//#region extensions/signal/src/channel.setup.ts
const signalSetupPlugin = { ...createSignalPluginBase({
	setupWizard: signalSetupWizard,
	setup: signalSetupAdapter
}) };
//#endregion
export { extractSignalCliArchive, formatSignalPairingIdLine, formatSignalSenderDisplay, formatSignalSenderId, installSignalCli, isSignalSenderAllowed, listEnabledSignalAccounts, listSignalAccountIds, looksLikeArchive, looksLikeSignalTargetId, looksLikeUuid, markdownToSignalText, markdownToSignalTextChunks, monitorSignalProvider, normalizeSignalAccountInput, normalizeSignalAllowRecipient, normalizeSignalMessagingTarget, pickAsset, probeSignal, removeReactionSignal, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalOutboundTarget, resolveSignalPeerId, resolveSignalReactionLevel, resolveSignalRecipient, resolveSignalSender, sendMessageSignal, sendReactionSignal, sendReadReceiptSignal, sendTypingSignal, signalMessageActions, signalPlugin, signalSetupPlugin };
