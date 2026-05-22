import { i as OpenClawConfig } from "../../types.openclaw-BMMD0Ykw.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-B20n5Nn2.js";
import { g as chunkText } from "../../outbound.types-Dn4sB4pn.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-CgjRAtD6.js";
import { y as OpenClawPluginApi } from "../../types-CWJThuOe2.js";
import { l as normalizeE164 } from "../../utils-BIopLFWh.js";
import { n as ChannelPlugin } from "../../types.public-ElAweHV2.js";
import { n as PluginRuntime } from "../../types-1xy7Ddy0.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DjJxy_iI.js";
import { r as buildChannelConfigSchema } from "../../config-schema-3flc7X46.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DRQ503Pg.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DAwA-9KG.js";
import { n as formatPairingApproveHint } from "../../helpers-DI_CU_Fg.js";
import { d as getChatChannelMeta } from "../../core-bwf5JCIf.js";
import { t as formatCliCommand } from "../../command-format-Dp7esp0z.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-BjgLzHtL.js";
import { t as detectBinary } from "../../detect-binary-BFN3rypt.js";
import { t as formatDocsLink } from "../../links-rHyL3Sru.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-CDhokHqN.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-BgbkNBgn.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-YBK4DQ3X.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-BJPhYru6.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-DubSAGvB.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-DY82xG3u.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-Dcfy0sZE.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-Czo067hr.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };