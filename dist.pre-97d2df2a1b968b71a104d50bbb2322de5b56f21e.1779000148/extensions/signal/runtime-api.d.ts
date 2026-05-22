import { i as OpenClawConfig } from "../../types.openclaw-BuKAF4PW.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-C01XwMRy.js";
import { h as chunkText } from "../../outbound.types-CYxlkHkP.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-TY_PD3kg.js";
import { y as OpenClawPluginApi } from "../../types-9OpM7mYQ.js";
import { l as normalizeE164 } from "../../utils-BAEx3b18.js";
import { n as ChannelPlugin } from "../../types.public-CzfdpDjZ.js";
import { n as PluginRuntime } from "../../types-6l5HWcJc.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-DdJ_UKu9.js";
import { r as buildChannelConfigSchema } from "../../config-schema-B_2f5acI.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-DQnlhKDY.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-VQKimakz.js";
import { n as formatPairingApproveHint } from "../../helpers-CWho29Yv.js";
import { d as getChatChannelMeta } from "../../core-DLehHqk3.js";
import { t as formatCliCommand } from "../../command-format-BJBcQWMC.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-DdSTLDmU.js";
import { t as detectBinary } from "../../detect-binary-BjPUTIvz.js";
import { t as formatDocsLink } from "../../links-2QK8c9m-.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-DlGgJwJW.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-D8qDDt6d.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-DuoyWjvX.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-DDdH27iV.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Dy_Yhlpg.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-BXYfz34I.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-DM7tp0cF.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-BHwiFC2V.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };