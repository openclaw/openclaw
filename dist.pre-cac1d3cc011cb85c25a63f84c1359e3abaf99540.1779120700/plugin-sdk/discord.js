import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../account-id-9_btbLFO.js";
import { i as getRuntimeConfig } from "../io-CkPP2awZ.js";
import { i as getRuntimeConfigSnapshot } from "../runtime-snapshot-Dg8HhGX3.js";
import { t as getChatChannelMeta } from "../chat-meta-42nqDCp5.js";
import { r as buildChannelConfigSchema } from "../config-schema-gd9RYI9s.js";
import { r as loadBundledPluginPublicSurfaceModuleSync, t as createLazyFacadeObjectValue } from "../facade-loader-DLYui4Ze.js";
import { a as resolveConfiguredFromCredentialStatuses, r as projectCredentialSnapshotFields } from "../account-snapshot-fields-CFxwu5OO.js";
import { r as emptyPluginConfigSchema } from "../config-schema-DpL4qtml.js";
import { s as migrateBaseNameToDefaultAccount, t as applyAccountNameToChannelSection } from "../setup-helpers-CH11mQRi.js";
import "../runtime-config-snapshot-Bpp0Doj8.js";
import { t as PAIRING_APPROVED_MESSAGE } from "../pairing-message-5hyKIuvT.js";
import "../channel-plugin-common-Dsj2UFYs.js";
import { o as buildTokenChannelStatusSummary, r as buildComputedAccountStatusSnapshot } from "../status-helpers-BunFlW3J.js";
import "../channel-status-DYYgC8Iv.js";
import { n as DiscordConfigSchema } from "../bundled-channel-config-schema-DKky0-Dd.js";
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
