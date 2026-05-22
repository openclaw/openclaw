import { o as coerceSecretRef } from "../types.secrets-BcE0iOnr.js";
import "../agent-scope-DKjUWHDL.js";
import { c as resolveDefaultAgentId } from "../agent-scope-config-D1eqrBeU.js";
import { n as resolveConfiguredSecretInputWithFallback, r as resolveRequiredConfiguredSecretRefInputString, t as resolveConfiguredSecretInputString } from "../resolve-configured-secret-input-string-DcZSysV-.js";
import { a as loadConfig, b as writeConfigFile, d as readConfigFileSnapshotForWrite, i as getRuntimeConfig, n as clearConfigCache } from "../io-BxFubSMj.js";
import { t as resolveAgentMaxConcurrent } from "../agent-limits-Y6_vNNMs.js";
import { i as resolveActiveTalkProviderConfig } from "../talk-CJDCzAx6.js";
import { _ as setRuntimeConfigSnapshot, i as getRuntimeConfigSnapshot, s as getRuntimeConfigSourceSnapshot, t as clearRuntimeConfigSnapshot } from "../runtime-snapshot-DgdkBEdP.js";
import { i as replaceConfigFile, n as mutateConfigFile } from "../mutate-DzIqAz79.js";
import { t as canonicalizeMainSessionAlias } from "../main-session-D3q_5w0B.js";
import { u as resolveStorePath } from "../paths---FlWJ0A.js";
import { F as resolveSessionStoreEntry, t as loadSessionStore$1 } from "../store-load-DM26fo1a.js";
import { S as resolveGroupSessionKey, a as readSessionUpdatedAt, c as saveSessionStore, d as updateSessionStoreEntry, f as upsertSessionEntry, i as patchSessionEntry, l as updateLastRoute, m as clearSessionStoreCacheForTest, n as getSessionEntry, o as recordSessionMetaFromInbound, r as listSessionEntries, u as updateSessionStore } from "../store-CuGD5gZu.js";
import { c as resolveSessionResetPolicy, i as resolveThreadFlag, n as resolveChannelResetConfig, o as evaluateSessionFreshness, r as resolveSessionResetType } from "../reset-D9XwPMPN.js";
import { n as resolveSessionKey } from "../session-key-C0qlw8ki.js";
import { i as resolveToolsBySender, n as resolveChannelGroupRequireMention, t as resolveChannelGroupPolicy } from "../group-policy-DSvijuiN.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, n as resolveAllowlistProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy, t as GROUP_POLICY_BLOCKED_LABEL } from "../runtime-group-policy-CmZDlIwd.js";
import { t as applyModelOverrideToSessionEntry } from "../model-overrides-CUnMI0Oj.js";
import { i as saveCronStore, r as resolveCronStorePath, t as loadCronStore } from "../store-DKRDcd4W.js";
import { t as resolveChannelModelOverride } from "../model-overrides-BU0MdOif.js";
import { n as filterSupplementalContextItems, t as evaluateSupplementalContextVisibility } from "../context-visibility-C9pX_aod.js";
import { t as resolveMarkdownTableMode } from "../markdown-tables-hRtLMxDi.js";
import { n as isDangerousNameMatchingEnabled, r as resolveDangerousNameMatchingEnabled } from "../dangerous-name-matching-jjAiM0PK.js";
import { n as resolveLivePluginConfigObject, r as resolvePluginConfigObject, t as requireRuntimeConfig } from "../plugin-config-runtime-CBCRjt8A.js";
import { r as logConfigUpdated } from "../logging-uBzxsys4.js";
import { u as updateConfig } from "../shared-DVGQVUdW.js";
import { n as resolveDefaultContextVisibility, t as resolveChannelContextVisibilityMode } from "../context-visibility-Si-TIKp_.js";
import { n as resolveNativeCommandsEnabled, r as resolveNativeSkillsEnabled, t as isNativeCommandsExplicitlyDisabled } from "../commands-BF5KocPr.js";
import { a as resolveTelegramCustomCommands, i as normalizeTelegramCommandName, t as TELEGRAM_COMMAND_NAME_PATTERN } from "../telegram-command-config-B46C1T1i.js";
//#region src/plugin-sdk/config-runtime.ts
/**
* @deprecated Public SDK subpath has no bundled extension production imports.
* Prefer narrower config subpaths such as plugin-config-runtime,
* config-mutation, and runtime-config-snapshot.
*/
/**
* @deprecated Use getSessionEntry/listSessionEntries for reads and
* patchSessionEntry/upsertSessionEntry for writes. loadSessionStore keeps the
* legacy mutable whole-store shape and will remain a compatibility escape hatch.
*/
const loadSessionStore = loadSessionStore$1;
//#endregion
export { GROUP_POLICY_BLOCKED_LABEL, TELEGRAM_COMMAND_NAME_PATTERN, applyModelOverrideToSessionEntry, canonicalizeMainSessionAlias, clearConfigCache, clearRuntimeConfigSnapshot, clearSessionStoreCacheForTest, coerceSecretRef, evaluateSessionFreshness, evaluateSupplementalContextVisibility, filterSupplementalContextItems, getRuntimeConfig, getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, getSessionEntry, isDangerousNameMatchingEnabled, isNativeCommandsExplicitlyDisabled, listSessionEntries, loadConfig, loadCronStore, loadSessionStore, logConfigUpdated, mutateConfigFile, normalizeTelegramCommandName, patchSessionEntry, readConfigFileSnapshotForWrite, readSessionUpdatedAt, recordSessionMetaFromInbound, replaceConfigFile, requireRuntimeConfig, resolveActiveTalkProviderConfig, resolveAgentMaxConcurrent, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelContextVisibilityMode, resolveChannelGroupPolicy, resolveChannelGroupRequireMention, resolveChannelModelOverride, resolveChannelResetConfig, resolveConfiguredSecretInputString, resolveConfiguredSecretInputWithFallback, resolveCronStorePath, resolveDangerousNameMatchingEnabled, resolveDefaultAgentId, resolveDefaultContextVisibility, resolveDefaultGroupPolicy, resolveGroupSessionKey, resolveLivePluginConfigObject, resolveMarkdownTableMode, resolveNativeCommandsEnabled, resolveNativeSkillsEnabled, resolveOpenProviderRuntimeGroupPolicy, resolvePluginConfigObject, resolveRequiredConfiguredSecretRefInputString, resolveSessionKey, resolveSessionResetPolicy, resolveSessionResetType, resolveSessionStoreEntry, resolveStorePath, resolveTelegramCustomCommands, resolveThreadFlag, resolveToolsBySender, saveCronStore, saveSessionStore, setRuntimeConfigSnapshot, updateConfig, updateLastRoute, updateSessionStore, updateSessionStoreEntry, upsertSessionEntry, warnMissingProviderGroupPolicyFallbackOnce, writeConfigFile };
