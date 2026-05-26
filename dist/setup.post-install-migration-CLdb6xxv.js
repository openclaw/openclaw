import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { p as readMigrationConfigPatchDetails, y as writeMigrationConfigPath } from "./migration-DGUrqTK8.js";
//#region src/wizard/setup.post-install-migration.ts
async function resolveCandidates(params) {
	if (params.installedPluginIds.length === 0) return [];
	const [{ ensureStandaloneMigrationProviderRegistryLoaded, resolvePluginMigrationProviders }, { resolveManifestContractRuntimePluginResolution }, { createMigrationLogger }, { resolveStateDir }] = await Promise.all([
		import("./migration-provider-runtime-Dh_hMm4_.js"),
		import("./manifest-contract-runtime-Bj87cKKl.js"),
		import("./context-CDGzwF29.js"),
		import("./paths-Bf5jv6F6.js")
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
function applyMigrationConfigPatches(config, result) {
	const patches = (result?.items ?? []).filter((item) => Boolean(item && typeof item === "object" && "kind" in item && item.kind === "config" && "action" in item && item.action === "merge" && "status" in item && item.status === "migrated")).map(readMigrationConfigPatchDetails).filter((patch) => patch !== void 0);
	if (patches.length === 0) return config;
	const nextConfig = structuredClone(config);
	for (const patch of patches) writeMigrationConfigPath(nextConfig, patch.path, patch.value);
	return nextConfig;
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
	if (candidates.length === 0) return { config: params.config };
	let nextConfig = params.config;
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
		let preparation = void 0;
		try {
			const [{ migrateDefaultCommand }, { createMigrationLogger }, { resolveStateDir }] = await Promise.all([
				import("./migrate-CIZGjruG.js"),
				import("./context-CDGzwF29.js"),
				import("./paths-Bf5jv6F6.js")
			]);
			preparation = await candidate.provider.prepareApply?.({
				config: nextConfig,
				stateDir: resolveStateDir(),
				logger: createMigrationLogger(params.runtime),
				...candidate.source ? { source: candidate.source } : {},
				providerOptions: { configPatchMode: "return" }
			});
			const result = await migrateDefaultCommand(params.runtime, {
				provider: candidate.provider.id,
				configOverride: nextConfig,
				configPatchMode: "return",
				suppressPlanLog: true
			});
			nextConfig = applyMigrationConfigPatches(nextConfig, result);
		} catch (error) {
			params.runtime.log(`${candidate.provider.label} migration failed: ${formatErrorMessage(error)}. Re-run with ${formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`)} to inspect.`);
		} finally {
			await preparation?.dispose?.();
		}
	}
	return { config: nextConfig };
}
//#endregion
export { offerPostInstallMigrations };
