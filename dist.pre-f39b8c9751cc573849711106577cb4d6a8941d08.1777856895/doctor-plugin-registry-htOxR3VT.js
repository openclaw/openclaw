import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { g as shortenHomePath } from "./utils-CCskKJVV.js";
import { h as refreshPluginRegistry } from "./plugin-registry-DiJTylvG.js";
import { i as preflightPluginRegistryInstallMigration, r as migratePluginRegistryForInstall, t as DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV } from "./plugin-registry-migration-BH7VpKKJ.js";
import { t as note } from "./note-CZdKFNS6.js";
//#region src/commands/doctor-plugin-registry.ts
async function maybeRepairPluginRegistryState(params) {
	const preflight = preflightPluginRegistryInstallMigration(params);
	for (const warning of preflight.deprecationWarnings) note(warning, "Plugin registry");
	if (preflight.action === "disabled") {
		note(`${DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV} is set; skipping plugin registry repair.`, "Plugin registry");
		return params.config;
	}
	const migrationParams = {
		...params,
		config: params.config
	};
	if (!params.prompter.shouldRepair) {
		if (preflight.action === "migrate") note(["Persisted plugin registry is missing or stale.", `Repair with ${formatCliCommand("openclaw doctor --fix")} to rebuild ${shortenHomePath(preflight.filePath)} from enabled plugins.`].join("\n"), "Plugin registry");
		return params.config;
	}
	if (preflight.action === "migrate") {
		const result = await migratePluginRegistryForInstall(migrationParams);
		if (result.migrated) {
			const total = result.current.plugins.length;
			const enabled = result.current.plugins.filter((plugin) => plugin.enabled).length;
			note(`Plugin registry rebuilt: ${enabled}/${total} enabled plugins indexed.`, "Plugin registry");
		}
		return params.config;
	}
	if (preflight.action === "skip-existing") {
		const index = await refreshPluginRegistry({
			...migrationParams,
			reason: "migration"
		});
		const total = index.plugins.length;
		const enabled = index.plugins.filter((plugin) => plugin.enabled).length;
		note(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`, "Plugin registry");
	}
	return params.config;
}
//#endregion
export { maybeRepairPluginRegistryState };
