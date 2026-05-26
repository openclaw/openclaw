import { c as resolveOfficialExternalPluginInstall, l as resolveOfficialExternalPluginLabel, r as getOfficialExternalPluginCatalogManifest, s as resolveOfficialExternalPluginId, t as getOfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { h as resolveConfiguredChannelPresencePolicy } from "./channel-plugin-ids-nB-ga3MN.js";
//#region src/plugins/official-external-plugin-repair-hints.ts
function resolveOfficialExternalPluginRepairHint(pluginIdOrChannelId) {
	const entry = getOfficialExternalPluginCatalogEntry(pluginIdOrChannelId);
	if (!entry) return null;
	const install = resolveOfficialExternalPluginInstall(entry);
	const npmSpec = install?.npmSpec?.trim();
	const clawhubSpec = install?.clawhubSpec?.trim();
	const installSpec = install?.defaultChoice === "clawhub" ? clawhubSpec ?? npmSpec : npmSpec ?? clawhubSpec;
	if (!installSpec) return null;
	const manifest = getOfficialExternalPluginCatalogManifest(entry);
	const pluginId = resolveOfficialExternalPluginId(entry) ?? pluginIdOrChannelId.trim();
	const channelId = manifest?.channel?.id?.trim();
	const label = resolveOfficialExternalPluginLabel(entry);
	const installCommand = `openclaw plugins install ${installSpec}`;
	const doctorFixCommand = "openclaw doctor --fix";
	return {
		pluginId,
		...channelId ? { channelId } : {},
		label,
		installSpec,
		installCommand,
		doctorFixCommand,
		repairHint: `Install the official external plugin with: ${installCommand}, or run: ${doctorFixCommand}.`
	};
}
function resolveMissingOfficialExternalChannelPluginRepairHint(params) {
	const hint = resolveOfficialExternalPluginRepairHint(params.channelId);
	if (!hint?.channelId || hint.channelId !== params.channelId) return null;
	const policy = resolveConfiguredChannelPresencePolicy({
		config: params.config,
		activationSourceConfig: params.activationSourceConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includePersistedAuthState: false
	}).find((entry) => entry.channelId === hint.channelId);
	if (!policy || policy.effective) return null;
	return policy.blockedReasons.length === 1 && policy.blockedReasons[0] === "no-channel-owner" ? hint : null;
}
//#endregion
export { resolveMissingOfficialExternalChannelPluginRepairHint as t };
