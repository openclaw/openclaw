import { n as normalizeAccountId } from "../account-id-05Z3mmpO.js";
import { a as onDiagnosticEvent } from "../diagnostic-events-BoxUqA8f.js";
import { n as resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir-D6cD8elg.js";
import { l as ToolPolicySchema } from "../zod-schema.agent-runtime-D3D7fvbE.js";
import { L as requireOpenAllowFrom, a as DmConfigSchema, b as ReplyRuntimeConfigSchemaShape, h as MarkdownConfigSchema, i as ContextVisibilityModeSchema, l as GroupPolicySchema, n as BlockStreamingCoalesceSchema, o as DmPolicySchema } from "../zod-schema.core-DMLDoxA0.js";
import { a as buildNestedDmConfigSchema, i as buildJsonChannelConfigSchema, n as buildCatchallMultiAccountChannelSchema, r as buildChannelConfigSchema, t as AllowFromListSchema } from "../config-schema-CLM6ogpT.js";
import { n as registerContextEngine } from "../registry-CDkQoYxF.js";
import { r as loadBundledPluginPublicSurfaceModuleSync } from "../facade-loader-vePhJg53.js";
import { n as delegateCompactionToRuntime, t as buildMemorySystemPromptAddition } from "../delegate-D--6rAmU.js";
import { i as writeOAuthCredentials, n as buildApiKeyCredential, r as upsertApiKeyProfile, t as applyAuthProfileConfig } from "../provider-auth-helpers-6f1xpdbI.js";
import "../common-DZqX8QYm.js";
import { i as stringEnum, r as optionalStringEnum } from "../typebox-CwMq9XEP.js";
import "../temp-path-D5yZLChq.js";
import { i as resolveToolsBySender, n as resolveChannelGroupRequireMention, r as resolveChannelGroupToolsPolicy, t as resolveChannelGroupPolicy } from "../group-policy-CHIp1weU.js";
import { a as createHybridChannelConfigBase, c as createScopedChannelConfigBase, d as createTopLevelChannelConfigBase, i as createHybridChannelConfigAdapter, l as createScopedDmSecurityResolver, m as mapAllowFromEntries, o as createScopedAccountConfigAccessors, s as createScopedChannelConfigAdapter, u as createTopLevelChannelConfigAdapter } from "../channel-config-helpers-LfEE_4Xc.js";
import { t as buildAccountScopedDmSecurityPolicy } from "../helpers-BUOSsuwP.js";
import "../identity-BtZhHHvn.js";
import { t as inspectReadOnlyChannelAccount } from "../read-only-account-inspect-DYL4zaA9.js";
import { t as KeyedAsyncQueue } from "../keyed-async-queue-rSt5UnGn.js";
import "../text-runtime-C_zPTqpT.js";
import { r as emptyPluginConfigSchema } from "../config-schema-DW8jXNGU.js";
import "../setup-helpers-D5cShzie.js";
import { n as resolveControlCommandGate } from "../command-gating-w1GKxLl9.js";
import { a as buildHistoryContextFromMap, c as clearHistoryEntriesIfEnabled, d as recordPendingHistoryEntryIfEnabled, i as buildHistoryContextFromEntries, l as evictOldHistoryKeys, n as HISTORY_CONTEXT_MARKER, o as buildPendingHistoryContextFromMap, r as buildHistoryContext, s as clearHistoryEntries, t as DEFAULT_GROUP_HISTORY_LIMIT, u as recordPendingHistoryEntry } from "../history-BYOv6xg5.js";
import { n as createReplyPrefixOptions$1, t as createReplyPrefixContext$1 } from "../reply-prefix-CFzY92IK.js";
import { t as createTypingCallbacks$1 } from "../typing-mqUA90Xn.js";
import { n as resolveChannelSourceReplyDeliveryMode$1, t as createChannelReplyPipeline$1 } from "../channel-reply-pipeline-TlW8N3_3.js";
import { t as createAccountStatusSink } from "../channel-lifecycle.core-gZjBaPFF.js";
import { t as createPluginRuntimeStore } from "../runtime-store-Wij_b93b.js";
import { a as mapAllowlistResolutionInputs, n as formatNormalizedAllowFromEntries, t as formatAllowFromLowercase } from "../allow-from-eZ6uedD3.js";
import "../channel-config-schema-He9BEOhc.js";
import { C as createOpenProviderGroupPolicyWarningCollector, D as projectConfigWarningCollector, E as projectConfigAccountIdWarningCollector, O as projectWarningCollector, S as createOpenProviderConfiguredRouteWarningCollector, T as projectAccountWarningCollector, _ as createAllowlistProviderOpenWarningCollector, a as buildOpenGroupPolicyConfigureRouteAllowlistWarning, b as createConditionalWarningCollector, c as collectAllowlistProviderGroupPolicyWarnings, d as collectOpenGroupPolicyRestrictSendersWarnings, f as collectOpenGroupPolicyRouteAllowlistWarnings, g as createAllowlistProviderGroupPolicyWarningCollector, h as composeWarningCollectors, i as normalizeAllowFromList, l as collectAllowlistProviderRestrictSendersWarnings, m as composeAccountWarningCollectors, n as createDangerousNameMatchingMutableAllowlistWarningCollector, o as buildOpenGroupPolicyRestrictSendersWarning, p as collectOpenProviderGroupPolicyWarnings, r as createRestrictSendersChannelSecurity, s as buildOpenGroupPolicyWarning, t as coerceNativeSetting, u as collectOpenGroupPolicyConfiguredRouteWarnings, v as createAllowlistProviderRestrictSendersWarningCollector, w as projectAccountConfigWarningCollector, x as createOpenGroupPolicyRestrictSendersWarningCollector, y as createAllowlistProviderRouteAllowlistWarningCollector } from "../channel-policy-CJIN_g7f.js";
import { a as resolveSenderScopedGroupPolicy, i as evaluateSenderGroupAccessForPolicy, t as evaluateGroupRouteAccessForPolicy } from "../group-access-C0bxOoE2.js";
import { a as resolveDmGroupAccessWithCommandGate, c as resolveOpenDmAllowlistAccess, n as readStoreAllowFromForDmPolicy, o as resolveDmGroupAccessWithLists, s as resolveEffectiveAllowFromLists, t as DM_GROUP_ACCESS_REASON } from "../dm-policy-shared-C7MlRVkr.js";
import "../reply-history-kFsd8Jaf.js";
import { i as nullChannelDirectorySelf, n as createEmptyChannelDirectoryAdapter, r as emptyChannelDirectoryList, t as createChannelDirectoryAdapter } from "../directory-runtime-CYvWRfuD.js";
import { a as listDirectoryEntriesFromSources, c as listDirectoryUserEntriesFromAllowFrom, d as listResolvedDirectoryEntriesFromSources, f as listResolvedDirectoryGroupEntriesFromMapKeys, i as createResolvedDirectoryEntriesLister, l as listDirectoryUserEntriesFromAllowFromAndMapKeys, m as toDirectoryEntries, n as collectNormalizedDirectoryIds, o as listDirectoryGroupEntriesFromMapKeys, p as listResolvedDirectoryUserEntriesFromAllowFrom, r as createInspectedDirectoryEntriesLister, s as listDirectoryGroupEntriesFromMapKeysAndAllowFrom, t as applyDirectoryQueryAndLimit, u as listInspectedDirectoryEntriesFromSources } from "../directory-config-helpers-Dxmnr_9k.js";
import { t as createRuntimeDirectoryLiveAdapter } from "../runtime-forwarders-BjtPxKSU.js";
import "../setup-wizard-helpers-BmlH_00g.js";
import "../channel-targets-DHuX-MKO.js";
import "../channel-pairing-CWWMPhAh.js";
import "../status-helpers-CaAM_77P.js";
import "../webhook-ingress-Bk-4qyTw.js";
//#region src/plugin-sdk/bluebubbles-policy.ts
function loadFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "bluebubbles",
		artifactBasename: "api.js"
	});
}
const resolveBlueBubblesGroupRequireMention = ((...args) => loadFacadeModule()["resolveBlueBubblesGroupRequireMention"](...args));
const resolveBlueBubblesGroupToolPolicy = ((...args) => loadFacadeModule()["resolveBlueBubblesGroupToolPolicy"](...args));
//#endregion
//#region src/plugin-sdk/bluebubbles.ts
function loadBlueBubblesFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "bluebubbles",
		artifactBasename: "api.js"
	});
}
function collectBlueBubblesStatusIssues(accounts) {
	return loadBlueBubblesFacadeModule().collectBlueBubblesStatusIssues(accounts);
}
//#endregion
//#region src/plugin-sdk/compat.ts
/**
* @deprecated Legacy compat surface for external plugins that still depend on
* older broad plugin-sdk imports. Use focused openclaw/plugin-sdk subpaths
* instead.
*/
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_PLUGIN_SDK_COMPAT_WARNING !== "1") process.emitWarning("openclaw/plugin-sdk/compat is deprecated for new plugins. Migrate to focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_PLUGIN_SDK_COMPAT_DEPRECATED",
	detail: "Bundled plugins must use scoped plugin-sdk subpaths. External plugins may keep compat temporarily while migrating. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
const createChannelReplyPipeline = createChannelReplyPipeline$1;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
const createReplyPrefixContext = createReplyPrefixContext$1;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
const createReplyPrefixOptions = createReplyPrefixOptions$1;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
const createTypingCallbacks = createTypingCallbacks$1;
/** @deprecated Use `openclaw/plugin-sdk/channel-reply-pipeline`. */
const resolveChannelSourceReplyDeliveryMode = resolveChannelSourceReplyDeliveryMode$1;
//#endregion
export { AllowFromListSchema, BlockStreamingCoalesceSchema, ContextVisibilityModeSchema, DEFAULT_GROUP_HISTORY_LIMIT, DM_GROUP_ACCESS_REASON, DmConfigSchema, DmPolicySchema, GroupPolicySchema, HISTORY_CONTEXT_MARKER, KeyedAsyncQueue, MarkdownConfigSchema, ReplyRuntimeConfigSchemaShape, ToolPolicySchema, applyAuthProfileConfig, applyDirectoryQueryAndLimit, buildAccountScopedDmSecurityPolicy, buildApiKeyCredential, buildCatchallMultiAccountChannelSchema, buildChannelConfigSchema, buildHistoryContext, buildHistoryContextFromEntries, buildHistoryContextFromMap, buildJsonChannelConfigSchema, buildMemorySystemPromptAddition, buildNestedDmConfigSchema, buildOpenGroupPolicyConfigureRouteAllowlistWarning, buildOpenGroupPolicyRestrictSendersWarning, buildOpenGroupPolicyWarning, buildPendingHistoryContextFromMap, clearHistoryEntries, clearHistoryEntriesIfEnabled, coerceNativeSetting, collectAllowlistProviderGroupPolicyWarnings, collectAllowlistProviderRestrictSendersWarnings, collectBlueBubblesStatusIssues, collectNormalizedDirectoryIds, collectOpenGroupPolicyConfiguredRouteWarnings, collectOpenGroupPolicyRestrictSendersWarnings, collectOpenGroupPolicyRouteAllowlistWarnings, collectOpenProviderGroupPolicyWarnings, composeAccountWarningCollectors, composeWarningCollectors, createAccountStatusSink, createAllowlistProviderGroupPolicyWarningCollector, createAllowlistProviderOpenWarningCollector, createAllowlistProviderRestrictSendersWarningCollector, createAllowlistProviderRouteAllowlistWarningCollector, createChannelDirectoryAdapter, createChannelReplyPipeline, createConditionalWarningCollector, createDangerousNameMatchingMutableAllowlistWarningCollector, createEmptyChannelDirectoryAdapter, createHybridChannelConfigAdapter, createHybridChannelConfigBase, createInspectedDirectoryEntriesLister, createOpenGroupPolicyRestrictSendersWarningCollector, createOpenProviderConfiguredRouteWarningCollector, createOpenProviderGroupPolicyWarningCollector, createPluginRuntimeStore, createReplyPrefixContext, createReplyPrefixOptions, createResolvedDirectoryEntriesLister, createRestrictSendersChannelSecurity, createRuntimeDirectoryLiveAdapter, createScopedAccountConfigAccessors, createScopedChannelConfigAdapter, createScopedChannelConfigBase, createScopedDmSecurityResolver, createTopLevelChannelConfigAdapter, createTopLevelChannelConfigBase, createTypingCallbacks, delegateCompactionToRuntime, emptyChannelDirectoryList, emptyPluginConfigSchema, evaluateGroupRouteAccessForPolicy, evaluateSenderGroupAccessForPolicy, evictOldHistoryKeys, formatAllowFromLowercase, formatNormalizedAllowFromEntries, inspectReadOnlyChannelAccount, listDirectoryEntriesFromSources, listDirectoryGroupEntriesFromMapKeys, listDirectoryGroupEntriesFromMapKeysAndAllowFrom, listDirectoryUserEntriesFromAllowFrom, listDirectoryUserEntriesFromAllowFromAndMapKeys, listInspectedDirectoryEntriesFromSources, listResolvedDirectoryEntriesFromSources, listResolvedDirectoryGroupEntriesFromMapKeys, listResolvedDirectoryUserEntriesFromAllowFrom, mapAllowFromEntries, mapAllowlistResolutionInputs, normalizeAccountId, normalizeAllowFromList, nullChannelDirectorySelf, onDiagnosticEvent, optionalStringEnum, projectAccountConfigWarningCollector, projectAccountWarningCollector, projectConfigAccountIdWarningCollector, projectConfigWarningCollector, projectWarningCollector, readStoreAllowFromForDmPolicy, recordPendingHistoryEntry, recordPendingHistoryEntryIfEnabled, registerContextEngine, requireOpenAllowFrom, resolveBlueBubblesGroupRequireMention, resolveBlueBubblesGroupToolPolicy, resolveChannelGroupPolicy, resolveChannelGroupRequireMention, resolveChannelGroupToolsPolicy, resolveChannelSourceReplyDeliveryMode, resolveControlCommandGate, resolveDmGroupAccessWithCommandGate, resolveDmGroupAccessWithLists, resolveEffectiveAllowFromLists, resolveOpenDmAllowlistAccess, resolvePreferredOpenClawTmpDir, resolveSenderScopedGroupPolicy, resolveToolsBySender, stringEnum, toDirectoryEntries, upsertApiKeyProfile, writeOAuthCredentials };
