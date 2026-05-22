import { i as OpenClawConfig } from "../../types.openclaw-DBDmmaVM.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Iwx-m7pc.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-Clghd6aI.js";
import { g as chunkText } from "../../outbound.types-B5xApU2S.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DA-emjB6.js";
import { C as OpenClawPluginApi } from "../../types-CPAF_tyr.js";
import { l as normalizeE164 } from "../../utils-DnMW-o0a.js";
import { n as ChannelPlugin } from "../../types.public-Cx-Og-oG.js";
import { n as PluginRuntime } from "../../types-BkonLdRT.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-CHyk886w.js";
import { r as buildChannelConfigSchema } from "../../config-schema-BsLYUSD_.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DtDqtfqZ.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-BUNHsGxi.js";
import { n as formatPairingApproveHint } from "../../helpers-DHlWrZzd.js";
import { d as getChatChannelMeta } from "../../core-BhEEvvks.js";
import { t as formatCliCommand } from "../../command-format-DuW7WS5u.js";
import { t as detectBinary } from "../../detect-binary-k25thN0D.js";
import { t as formatDocsLink } from "../../links-n2gY7cfK.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DeCAMmmi.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-krgJT8On.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-CTxy4utA.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-KMjFyoSF.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-BRFZGrCX.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-N_D_yHAX.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-1WdzvB4l.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-Dk82YwrG.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };