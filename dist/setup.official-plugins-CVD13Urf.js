import { a as listOfficialExternalPluginCatalogEntries, c as resolveOfficialExternalPluginInstall, l as resolveOfficialExternalPluginLabel, r as getOfficialExternalPluginCatalogManifest, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { n as t } from "./i18n-CWNhN747.js";
import { t as ensureOnboardingPluginInstalled } from "./onboarding-plugin-install-OsJyL8Nc.js";
//#region src/wizard/setup.official-plugins.ts
const SKIP_VALUE = "__skip__";
function isInstalledOrConfigured(config, pluginId) {
	return Boolean(config.plugins?.entries?.[pluginId] || config.plugins?.installs?.[pluginId]);
}
function isGenericOfficialPluginEntry(entry) {
	const manifest = getOfficialExternalPluginCatalogManifest(entry);
	return entry.source === "official" && entry.kind === "plugin" && Boolean(manifest?.plugin?.id) && !manifest?.channel && (manifest?.providers?.length ?? 0) === 0 && (manifest?.webSearchProviders?.length ?? 0) === 0;
}
function formatInstallHint(install) {
	if (install.clawhubSpec && install.npmSpec) return install.defaultChoice === "clawhub" ? "ClawHub, with npm fallback" : "npm, with ClawHub fallback";
	if (install.clawhubSpec) return "ClawHub";
	if (install.npmSpec) return "npm";
	if (install.localPath) return "local path";
	return "install source";
}
function resolveOfficialPluginOnboardingInstallEntries(params) {
	const entries = [];
	for (const entry of listOfficialExternalPluginCatalogEntries()) {
		if (!isGenericOfficialPluginEntry(entry)) continue;
		const pluginId = resolveOfficialExternalPluginId(entry);
		const install = resolveOfficialExternalPluginInstall(entry);
		if (!pluginId || !install || isInstalledOrConfigured(params.config, pluginId)) continue;
		entries.push({
			pluginId,
			label: resolveOfficialExternalPluginLabel(entry),
			...entry.description ? { description: entry.description } : {},
			install,
			trustedSourceLinkedOfficialInstall: true
		});
	}
	return entries.toSorted((left, right) => left.label.localeCompare(right.label));
}
async function setupOfficialPluginInstalls(params) {
	const installEntries = resolveOfficialPluginOnboardingInstallEntries({ config: params.config });
	if (installEntries.length === 0) return params.config;
	const selected = await params.prompter.multiselect({
		message: t("wizard.plugins.officialInstall"),
		options: [{
			value: SKIP_VALUE,
			label: t("common.skipForNow"),
			hint: t("wizard.plugins.officialSkipHint")
		}, ...installEntries.map((entry) => ({
			value: entry.pluginId,
			label: entry.label,
			hint: entry.description ?? formatInstallHint(entry.install)
		}))]
	});
	let next = params.config;
	for (const pluginId of selected.filter((value) => value !== SKIP_VALUE)) {
		const entry = installEntries.find((candidate) => candidate.pluginId === pluginId);
		if (!entry) continue;
		next = (await ensureOnboardingPluginInstalled({
			cfg: next,
			entry,
			prompter: params.prompter,
			runtime: params.runtime,
			workspaceDir: params.workspaceDir,
			promptInstall: false
		})).cfg;
	}
	return next;
}
//#endregion
export { setupOfficialPluginInstalls };
