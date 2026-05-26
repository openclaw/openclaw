import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-Dh6XMgGH.js";
import { E as resolveChannelMediaMaxBytes } from "../../media-runtime-Bfz5QAml.js";
import { g as chunkText } from "../../outbound.types-D7agCOHK.js";
import { y as ChannelMessageActionAdapter } from "../../types.core-BkmTlRzr.js";
import { C as OpenClawPluginApi } from "../../types-Vx7Jq4_-2.js";
import { l as normalizeE164 } from "../../utils-DSrjARXN.js";
import { n as ChannelPlugin } from "../../types.public-B2Ho5PN_.js";
import { n as PluginRuntime } from "../../types-DpjQFFwi.js";
import { r as emptyPluginConfigSchema } from "../../config-schema-GpMHxsPW.js";
import { r as buildChannelConfigSchema } from "../../config-schema-Dx48Ud8L.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../../setup-helpers-CEKowBd4.js";
import { n as deleteAccountFromConfigSection, r as setAccountEnabledInConfigSection } from "../../config-helpers-Dcf1H7Kz.js";
import { n as formatPairingApproveHint } from "../../helpers-CdP0-HhA.js";
import { d as getChatChannelMeta } from "../../core-mTEouOrz.js";
import { t as formatCliCommand } from "../../command-format-d2gWtZzp.js";
import { t as detectBinary } from "../../detect-binary-DqlFLJ1Y.js";
import { t as formatDocsLink } from "../../links-Dz13kJx9.js";
import { n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "../../runtime-group-policy-BQMFOBke.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../../pairing-message-AZcwFUZz.js";
import { c as collectStatusIssuesFromLastError, d as createDefaultChannelRuntimeState, n as buildBaseChannelStatusSummary, t as buildBaseAccountStatusSnapshot } from "../../status-helpers-Cb-zgqXR.js";
import { o as SignalConfigSchema } from "../../bundled-channel-config-schema-4eXcH-RE.js";
import { a as resolveSignalAccount, c as probeSignal, i as resolveDefaultSignalAccountId, n as listEnabledSignalAccounts, o as SignalAccountConfig, r as listSignalAccountIds, t as ResolvedSignalAccount } from "../../accounts-Bs5xT9n9.js";
import { a as sendMessageSignal, f as monitorSignalProvider, p as signalMessageActions, u as resolveSignalReactionLevel } from "../../send-DHXH4pW3.js";
import { c as installSignalCli, n as normalizeSignalMessagingTarget, t as looksLikeSignalTargetId } from "../../normalize-BtYM5FLJ.js";
import { i as sendReactionSignal, r as removeReactionSignal } from "../../send-reactions-BZcn5zZ0.js";

//#region extensions/signal/src/runtime.d.ts
declare const setSignalRuntime: (next: PluginRuntime) => void, clearSignalRuntime: () => void;
//#endregion
export { type ChannelMessageActionAdapter, type ChannelPlugin, DEFAULT_ACCOUNT_ID, type OpenClawConfig, type OpenClawPluginApi, PAIRING_APPROVED_MESSAGE, type PluginRuntime, type ResolvedSignalAccount, type SignalAccountConfig, SignalConfigSchema, applyAccountNameToChannelSection, buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary, buildChannelConfigSchema, chunkText, collectStatusIssuesFromLastError, createDefaultChannelRuntimeState, deleteAccountFromConfigSection, detectBinary, emptyPluginConfigSchema, formatCliCommand, formatDocsLink, formatPairingApproveHint, getChatChannelMeta, installSignalCli, listEnabledSignalAccounts, listSignalAccountIds, looksLikeSignalTargetId, migrateBaseNameToDefaultAccount, monitorSignalProvider, normalizeAccountId, normalizeE164, normalizeSignalMessagingTarget, probeSignal, removeReactionSignal, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, resolveDefaultSignalAccountId, resolveSignalAccount, resolveSignalReactionLevel, sendMessageSignal, sendReactionSignal, setAccountEnabledInConfigSection, setSignalRuntime, signalMessageActions };