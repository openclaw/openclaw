import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../account-id-fkYplFFW.js";
import { i as getRuntimeConfig } from "../io-DJ0qH7nz.js";
import { i as getRuntimeConfigSnapshot } from "../runtime-snapshot-BbDqBMPM.js";
import { r as buildChannelConfigSchema } from "../config-schema-Cv6_wz1q.js";
import { n as DiscordConfigSchema } from "../zod-schema.providers-whatsapp-BGYiCmAE.js";
import { t as getChatChannelMeta } from "../chat-meta--2Jcz1Mq.js";
import { r as loadBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeObjectValue } from "../facade-loader-ZZ9aSB6i.js";
import { a as resolveConfiguredFromCredentialStatuses, r as projectCredentialSnapshotFields } from "../account-snapshot-fields-Cypu7gLc.js";
import { r as emptyPluginConfigSchema } from "../config-schema-q-T0QfDn.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../setup-helpers-Bdc21zG9.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../pairing-message-CQAMfMKv.js";
import { o as buildTokenChannelStatusSummary, r as buildComputedAccountStatusSnapshot } from "../status-helpers-Bt2mvr5s.js";
import "../runtime-config-snapshot-Cth5ZQPA.js";
import "../channel-plugin-common-Blb6MBuJ.js";
import "../channel-status-C5TtpNEM.js";
import "../bundled-channel-config-schema-DRT5DA4i.js";
//#region src/plugin-sdk/discord.ts
function loadDiscordApiFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "discord",
		artifactBasename: "api.js"
	});
}
function loadDiscordRuntimeFacadeModule() {
	return loadBundledPluginPublicSurfaceModuleSync({
		dirName: "discord",
		artifactBasename: "runtime-api.js"
	});
}
function resolveCompatRuntimeConfig(params) {
	return params.cfg ?? getRuntimeConfigSnapshot() ?? getRuntimeConfig();
}
const discordOnboardingAdapter = createLazyFacadeObjectValue(() => loadDiscordApiFacadeModule().discordOnboardingAdapter ?? {});
function collectDiscordStatusIssues(accounts) {
	return loadDiscordApiFacadeModule().collectDiscordStatusIssues(accounts);
}
const buildDiscordComponentMessage = ((...args) => loadDiscordApiFacadeModule().buildDiscordComponentMessage(...args));
function inspectDiscordAccount(params) {
	return loadDiscordApiFacadeModule().inspectDiscordAccount(params);
}
function listDiscordAccountIds(cfg) {
	return loadDiscordApiFacadeModule().listDiscordAccountIds(cfg);
}
function listDiscordDirectoryGroupsFromConfig(params) {
	return loadDiscordApiFacadeModule().listDiscordDirectoryGroupsFromConfig(params);
}
function listDiscordDirectoryPeersFromConfig(params) {
	return loadDiscordApiFacadeModule().listDiscordDirectoryPeersFromConfig(params);
}
function looksLikeDiscordTargetId(raw) {
	return loadDiscordApiFacadeModule().looksLikeDiscordTargetId(raw);
}
function normalizeDiscordMessagingTarget(raw) {
	return loadDiscordApiFacadeModule().normalizeDiscordMessagingTarget(raw);
}
function normalizeDiscordOutboundTarget(to) {
	return loadDiscordApiFacadeModule().normalizeDiscordOutboundTarget(to);
}
function resolveDefaultDiscordAccountId(cfg) {
	return loadDiscordApiFacadeModule().resolveDefaultDiscordAccountId(cfg);
}
function resolveDiscordAccount(params) {
	return loadDiscordApiFacadeModule().resolveDiscordAccount(params);
}
function resolveDiscordGroupRequireMention(params) {
	return loadDiscordApiFacadeModule().resolveDiscordGroupRequireMention(params);
}
function resolveDiscordGroupToolPolicy(params) {
	return loadDiscordApiFacadeModule().resolveDiscordGroupToolPolicy(params);
}
function collectDiscordAuditChannelIds(params) {
	return loadDiscordRuntimeFacadeModule().collectDiscordAuditChannelIds(params);
}
const editDiscordComponentMessage = ((...args) => loadDiscordRuntimeFacadeModule().editDiscordComponentMessage(...args));
const registerBuiltDiscordComponentMessage = ((...args) => loadDiscordRuntimeFacadeModule().registerBuiltDiscordComponentMessage(...args));
async function autoBindSpawnedDiscordSubagent(params) {
	return await loadDiscordRuntimeFacadeModule().autoBindSpawnedDiscordSubagent({
		...params,
		cfg: resolveCompatRuntimeConfig(params)
	});
}
function listThreadBindingsBySessionKey(params) {
	return loadDiscordRuntimeFacadeModule().listThreadBindingsBySessionKey(params);
}
function unbindThreadBindingsBySessionKey(params) {
	return loadDiscordRuntimeFacadeModule().unbindThreadBindingsBySessionKey(params);
}
//#endregion
export { DEFAULT_ACCOUNT_ID, DiscordConfigSchema, PAIRING_APPROVED_MESSAGE, applyAccountNameToChannelSection, autoBindSpawnedDiscordSubagent, buildChannelConfigSchema, buildComputedAccountStatusSnapshot, buildDiscordComponentMessage, buildTokenChannelStatusSummary, collectDiscordAuditChannelIds, collectDiscordStatusIssues, discordOnboardingAdapter, editDiscordComponentMessage, emptyPluginConfigSchema, getChatChannelMeta, inspectDiscordAccount, listDiscordAccountIds, listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listThreadBindingsBySessionKey, looksLikeDiscordTargetId, migrateBaseNameToDefaultAccount, normalizeAccountId, normalizeDiscordMessagingTarget, normalizeDiscordOutboundTarget, projectCredentialSnapshotFields, registerBuiltDiscordComponentMessage, resolveConfiguredFromCredentialStatuses, resolveDefaultDiscordAccountId, resolveDiscordAccount, resolveDiscordGroupRequireMention, resolveDiscordGroupToolPolicy, unbindThreadBindingsBySessionKey };
