import { n as ChannelPlugin } from "../../types.public-B2Ho5PN_.js";
import { n as RoutePeer } from "../../resolve-route-BZP_W0Z9.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, r as listSignalAccountIds, s as SignalProbe, t as ResolvedSignalAccount } from "../../accounts-Bs5xT9n9.js";
import { t as signalPlugin } from "../../channel-DSON1k5L.js";
import { _ as markdownToSignalTextChunks, a as sendMessageSignal, c as ResolvedSignalReactionLevel, d as MonitorSignalOpts, f as monitorSignalProvider, g as markdownToSignalText, h as SignalTextStyleRange, i as SignalSendResult, l as SignalReactionLevel, m as SignalFormattedText, n as SignalRpcOpts, o as sendReadReceiptSignal, p as signalMessageActions, r as SignalSendOpts, s as sendTypingSignal, t as SignalReceiptType, u as resolveSignalReactionLevel } from "../../send-DHXH4pW3.js";
import { a as isSignalSenderAllowed, c as resolveSignalRecipient, i as formatSignalSenderId, l as resolveSignalSender, n as formatSignalPairingIdLine, o as normalizeSignalAllowRecipient, r as formatSignalSenderDisplay, s as resolveSignalPeerId, t as SignalSender, u as looksLikeUuid } from "../../identity-DLlvfU6p.js";
import { a as SignalInstallResult, c as installSignalCli, d as pickAsset, i as ReleaseAsset, n as normalizeSignalMessagingTarget, r as NamedAsset, s as extractSignalCliArchive, t as looksLikeSignalTargetId, u as looksLikeArchive } from "../../normalize-BtYM5FLJ.js";
import { i as sendReactionSignal, n as SignalReactionResult, r as removeReactionSignal, t as SignalReactionOpts } from "../../send-reactions-BZcn5zZ0.js";

//#region extensions/signal/src/channel.setup.d.ts
declare const signalSetupPlugin: ChannelPlugin<ResolvedSignalAccount>;
//#endregion
//#region extensions/signal/src/outbound-session.d.ts
type ResolvedSignalOutboundTarget = {
  peer: RoutePeer;
  chatType: "direct" | "group";
  from: string;
  to: string;
};
declare function resolveSignalOutboundTarget(target: string): ResolvedSignalOutboundTarget | null;
//#endregion
//#region extensions/signal/src/setup-core.d.ts
declare function normalizeSignalAccountInput(value: string | null | undefined): string | null;
//#endregion
export { type MonitorSignalOpts, type NamedAsset, type ReleaseAsset, type ResolvedSignalAccount, type ResolvedSignalOutboundTarget, type ResolvedSignalReactionLevel, type SignalFormattedText, type SignalInstallResult, type SignalProbe, type SignalReactionLevel, type SignalReactionOpts, type SignalReactionResult, type SignalReceiptType, type SignalRpcOpts, type SignalSendOpts, type SignalSendResult, type SignalSender, type SignalTextStyleRange, extractSignalCliArchive, formatSignalPairingIdLine, formatSignalSenderDisplay, formatSignalSenderId, installSignalCli, isSignalSenderAllowed, listEnabledSignalAccounts, listSignalAccountIds, looksLikeArchive, looksLikeSignalTargetId, looksLikeUuid, markdownToSignalText, markdownToSignalTextChunks, monitorSignalProvider, normalizeSignalAccountInput, normalizeSignalAllowRecipient, normalizeSignalMessagingTarget, pickAsset, probeSignal, removeReactionSignal, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalOutboundTarget, resolveSignalPeerId, resolveSignalReactionLevel, resolveSignalRecipient, resolveSignalSender, sendMessageSignal, sendReactionSignal, sendReadReceiptSignal, sendTypingSignal, signalMessageActions, signalPlugin, signalSetupPlugin };