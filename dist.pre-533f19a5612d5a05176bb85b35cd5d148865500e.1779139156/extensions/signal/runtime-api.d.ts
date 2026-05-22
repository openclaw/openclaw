import { i as OpenClawConfig } from "../../types.openclaw-Bpxi7OSY.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CocONTDn.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-Dosgf_na.js";
import { g as chunkText } from "../../outbound.types-OtuBniOT.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-1gJzFdXJ.js";
import { C as OpenClawPluginApi } from "../../types-Cdl1yOYR.js";
import { l as normalizeE164 } from "../../utils-Crlp6Geq.js";
import { n as ChannelPlugin } from "../../types.public-oY5Zsold.js";
import { n as PluginRuntime } from "../../types-Dsa-0Faj.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-zsuDmHdZ.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Cu4qnl0J.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DKGLffWD.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-AiQpDarh.js";
import { n as formatPairingApproveHint } from "../../helpers-fkMMKEjW.js";
import { d as getChatChannelMeta } from "../../core-CqmaDLtY.js";
import { t as formatCliCommand } from "../../command-format-BGNoB7zj.js";
import { t as detectBinary } from "../../detect-binary-DdU8B7vo.js";
import { t as formatDocsLink } from "../../links-DfqzRCYM.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CtQ47EKo.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BCnDfHsA.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-B_3UIY7e.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-9wuNl8n4.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-rgs7Sv1U.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-BjkTHD2A.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-DCG2c815.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-CD0eZtJy.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };