import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
//#region src/wizard/setup.post-install-migration.ts
async function resolveCandidates(params) {
	if (params.installedPluginIds.length === 0) return [];
	const [{ ensureStandaloneMigrationProviderRegistryLoaded, resolvePluginMigrationProviders }, { resolveManifestContractRuntimePluginResolution }, { createMigrationLogger }, { resolveStateDir }] = await Promise.all([
		import("./migration-provider-runtime-BEFuGLzo.js"),
		import("./manifest-contract-runtime-Byqkrcdy.js"),
		import("./context-CexvtQgT.js"),
		import("./paths-MZ-M2Qqm.js")
	]);
	ensureStandaloneMigrationProviderRegistryLoaded({ cfg: params.config });
	const installedIds = new Set(params.installedPluginIds);
	const providers = resolvePluginMigrationProviders({ cfg: params.config });
	const stateDir = resolveStateDir();
	const logger = createMigrationLogger(params.runtime);
	const candidates = [];
	for (const provider of providers) {
		if (!provider.detect) continue;
		if (!resolveManifestContractRuntimePluginResolution({
			cfg: params.config,
			contract: "migrationProviders",
			value: provider.id
		}).pluginIds.some((pluginId) => installedIds.has(pluginId))) continue;
		try {
			const detection = await provider.detect({
				config: params.config,
				stateDir,
				logger
			});
			if (!detection.found || detection.confidence === "low") continue;
			candidates.push({
				provider,
				...detection.source ? { source: detection.source } : {}
			});
		} catch (error) {
			logger.debug?.(`Post-install migration detect for ${provider.id} failed: ${formatErrorMessage(error)}`);
		}
	}
	return candidates;
}
function describeCandidate(candidate) {
	const parts = [candidate.provider.label];
	if (candidate.source) parts.push(`at ${candidate.source}`);
	return parts.join(" ");
}
function logMigrationHint(runtime, candidate) {
	const command = formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`);
	runtime.log(`Detected ${describeCandidate(candidate)}. Preview migration with ${command}.`);
}
/**
* Offer interactive migration for any migration provider owned by a plugin
* that was just installed during onboarding. In non-interactive mode this is
* a no-op apart from a hint line so scripted setups never mutate state
* unexpectedly. The actual migration UI (skill/plugin checkboxes, confirm
* prompt) is owned by `openclaw migrate <provider>`; this helper only owns
* the gate prompt.
*/
async function offerPostInstallMigrations(params) {
	const candidates = await resolveCandidates({
		config: params.config,
		runtime: params.runtime,
		installedPluginIds: params.installedPluginIds
	});
	if (candidates.length === 0) return;
	const prompter = params.prompter;
	const interactive = params.nonInteractive !== true && process.stdin.isTTY && prompter !== void 0;
	for (const candidate of candidates) {
		if (!interactive || !prompter) {
			logMigrationHint(params.runtime, candidate);
			continue;
		}
		const description = describeCandidate(candidate);
		let accepted = false;
		try {
			accepted = await prompter.confirm({
				message: `Migrate ${description} into this agent now?`,
				initialValue: false
			});
		} catch (error) {
			params.runtime.log(`Skipping ${candidate.provider.label} migration prompt: ${formatErrorMessage(error)}`);
			logMigrationHint(params.runtime, candidate);
			continue;
		}
		if (!accepted) {
			logMigrationHint(params.runtime, candidate);
			continue;
		}
		try {
			const { migrateDefaultCommand } = await import("./migrate-DLmIgkfr.js");
			await migrateDefaultCommand(params.runtime, {
				provider: candidate.provider.id,
				suppressPlanLog: true
			});
		} catch (error) {
			params.runtime.log(`${candidate.provider.label} migration failed: ${formatErrorMessage(error)}. Re-run with ${formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`)} to inspect.`);
		}
	}
}
//#endregion
export { offerPostInstallMigrations };
