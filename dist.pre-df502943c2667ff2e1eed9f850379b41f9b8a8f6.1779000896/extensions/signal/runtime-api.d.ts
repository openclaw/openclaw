import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-BP6vIgTy.js";
import { h as chunkText } from "../../outbound.types-Bg2PsyCs.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-DWkvQuBM.js";
import { y as OpenClawPluginApi } from "../../types-DdGVOQ6y.js";
import { l as normalizeE164 } from "../../utils-BzWfLPK5.js";
import { n as ChannelPlugin } from "../../types.public-i4hJTC6b.js";
import { n as PluginRuntime } from "../../types-_VshWtBa.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-Cn1UWvnK.js";
import { r as buildChannelConfigSchema } from "../../config-schema-D2DpU2CE.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-BEeclsym.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-DAohv8ra.js";
import { n as formatPairingApproveHint } from "../../helpers-BoYytgiK.js";
import { d as getChatChannelMeta } from "../../core-Dqkj3vX0.js";
import { t as formatCliCommand } from "../../command-format-5_6gGDI7.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-geeohgS7.js";
import { t as detectBinary } from "../../detect-binary-DXc-0ME8.js";
import { t as formatDocsLink } from "../../links-B5hM5epm.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-HCcU4MwG.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-X7ok4ayY.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-BpP4DJGm.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-Y7Pt-2db.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-CCMx0Fbu.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-CHePF_9u.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-BBkm1IYn.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-CwlY9k-v.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };