import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
import { t as backupCreateCommand } from "./backup-DECsNxAG.js";
import { n as resolvePluginMigrationProvider, r as resolvePluginMigrationProviders, t as ensureStandaloneMigrationProviderRegistryLoaded } from "./migration-provider-runtime-1_CHPe5H.js";
import { n as buildMigrationReportDir, t as buildMigrationContext } from "./context-PIjRXz75.js";
import { c as applyMigrationPluginSelection, d as applyMigrationSkillSelection, i as writeApplyResult, n as assertConflictFreePlan, t as assertApplySucceeded } from "./output-BTyNcf8a.js";
import fs from "node:fs/promises";
//#region src/commands/migrate/providers.ts
function resolveMigrationProvider(providerId) {
	const config = getRuntimeConfig();
	ensureStandaloneMigrationProviderRegistryLoaded({ cfg: config });
	const provider = resolvePluginMigrationProvider({
		providerId,
		cfg: config
	});
	if (!provider) {
		const available = resolvePluginMigrationProviders({ cfg: config }).map((entry) => entry.id);
		const suffix = available.length > 0 ? ` Available providers: ${available.join(", ")}.` : " No providers found.";
		throw new Error(`Unknown migration provider "${providerId}".${suffix}`);
	}
	return provider;
}
function buildMigrationProviderOptions(opts) {
	if (opts.provider === "codex" && opts.verifyPluginApps === true) return { verifyPluginApps: true };
}
async function createMigrationPlan(runtime, opts) {
	if (opts.verifyPluginApps && opts.provider !== "codex") throw new Error("--verify-plugin-apps is only supported for Codex migrations.");
	const provider = resolveMigrationProvider(opts.provider);
	const ctx = buildMigrationContext({
		source: opts.source,
		includeSecrets: opts.includeSecrets,
		overwrite: opts.overwrite,
		providerOptions: buildMigrationProviderOptions(opts),
		runtime,
		json: opts.json
	});
	return await provider.plan(ctx);
}
//#endregion
//#region src/commands/migrate/apply.ts
function shouldTreatMissingBackupAsEmptyState(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("No local OpenClaw state was found to back up") || message.includes("No OpenClaw config file was found to back up");
}
async function createPreMigrationBackup(opts) {
	try {
		return (await backupCreateCommand({
			log() {},
			error() {},
			exit(code) {
				throw new Error(`backup exited with ${code}`);
			}
		}, {
			output: opts.output,
			verify: true
		})).archivePath;
	} catch (err) {
		if (shouldTreatMissingBackupAsEmptyState(err)) return;
		throw err;
	}
}
async function runMigrationApply(params) {
	const applyMigration = async (progress) => {
		const total = (params.opts.preflightPlan ? 0 : 1) + (params.opts.noBackup ? 0 : 1) + 1;
		let completed = 0;
		const tick = () => {
			completed += 1;
			progress?.setPercent(completed / total * 100);
		};
		if (!params.opts.preflightPlan) progress?.setLabel("Preparing migration plan…");
		const preflightPlan = params.opts.preflightPlan ?? await params.provider.plan(buildMigrationContext({
			source: params.opts.source,
			includeSecrets: params.opts.includeSecrets,
			overwrite: params.opts.overwrite,
			providerOptions: buildMigrationProviderOptions(params.opts),
			runtime: params.runtime,
			json: params.opts.json
		}));
		if (!params.opts.preflightPlan) tick();
		const selectedPlan = applyMigrationPluginSelection(applyMigrationSkillSelection(preflightPlan, params.opts.skills), params.opts.plugins);
		assertConflictFreePlan(selectedPlan, params.providerId);
		const stateDir = resolveStateDir();
		const reportDir = buildMigrationReportDir(params.providerId, stateDir);
		if (!params.opts.noBackup) progress?.setLabel("Preparing migration backup…");
		const backupPath = params.opts.noBackup ? void 0 : await createPreMigrationBackup({ output: params.opts.backupOutput });
		if (!params.opts.noBackup) tick();
		await fs.mkdir(reportDir, { recursive: true });
		const ctx = buildMigrationContext({
			source: params.opts.source,
			includeSecrets: params.opts.includeSecrets,
			overwrite: params.opts.overwrite,
			providerOptions: buildMigrationProviderOptions(params.opts),
			runtime: params.runtime,
			backupPath,
			reportDir,
			json: params.opts.json
		});
		progress?.setLabel("Applying migration…");
		const result = await params.provider.apply(ctx, selectedPlan);
		tick();
		return {
			...result,
			backupPath: result.backupPath ?? backupPath,
			reportDir: result.reportDir ?? reportDir
		};
	};
	const withBackup = params.opts.json ? await applyMigration() : await withProgress({ label: `Applying ${params.providerId} migration…` }, async (progress) => await applyMigration(progress));
	writeApplyResult(params.runtime, params.opts, withBackup);
	assertApplySucceeded(withBackup);
	return withBackup;
}
//#endregion
export { resolveMigrationProvider as i, runMigrationApply as n, createMigrationPlan as r, createPreMigrationBackup as t };
