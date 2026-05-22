import { i as OpenClawConfig } from "../../types.openclaw-BlE9q7jU.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-CHNX91pr.js";
import { h as chunkText } from "../../outbound.types-Bzt2qlxn.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BoZgMdCh.js";
import { v as OpenClawPluginApi } from "../../types-DzNNj7u7.js";
import { l as normalizeE164 } from "../../utils-CgYhRCJm.js";
import { n as ChannelPlugin } from "../../types.public-Bp4rl8_W.js";
import { n as PluginRuntime } from "../../types-6GKVZ6OQ.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DspKtwim.js";
import { r as buildChannelConfigSchema } from "../../config-schema-z_IyuJQR.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CExMsnzu.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DtJuWEDz.js";
import { n as formatPairingApproveHint } from "../../helpers-CwjEzsgx.js";
import { d as getChatChannelMeta } from "../../core-CohOQvme.js";
import { t as formatDocsLink } from "../../links-DKbqfDmC.js";
import { t as formatCliCommand } from "../../command-format-BGNoB7zj.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-BlQMW_d7.js";
import { t as detectBinary } from "../../detect-binary-70ntCu10.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-Ya8W-NBn.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-Daiomu0c.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DI7-87gZ.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DyeFBseO.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-BH2ANrMv.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-CakISZdo.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-DEmfU-Kl.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-DJ9pPocR.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };