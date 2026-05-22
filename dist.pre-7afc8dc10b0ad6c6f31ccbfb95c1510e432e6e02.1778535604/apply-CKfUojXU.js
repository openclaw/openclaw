import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { t as backupCreateCommand } from "./backup-BdNajPuA.js";
import { n as buildMigrationReportDir, t as buildMigrationContext } from "./context-Cqw8v1eh.js";
import { c as applyMigrationPluginSelection, d as applyMigrationSkillSelection, i as writeApplyResult, n as assertConflictFreePlan, t as assertApplySucceeded } from "./output-DksNLDQ9.js";
import fs from "node:fs/promises";
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
	const selectedPlan = applyMigrationPluginSelection(applyMigrationSkillSelection(params.opts.preflightPlan ?? await params.provider.plan(buildMigrationContext({
		source: params.opts.source,
		includeSecrets: params.opts.includeSecrets,
		overwrite: params.opts.overwrite,
		runtime: params.runtime,
		json: params.opts.json
	})), params.opts.skills), params.opts.plugins);
	assertConflictFreePlan(selectedPlan, params.providerId);
	const stateDir = resolveStateDir();
	const reportDir = buildMigrationReportDir(params.providerId, stateDir);
	const backupPath = params.opts.noBackup ? void 0 : await createPreMigrationBackup({ output: params.opts.backupOutput });
	await fs.mkdir(reportDir, { recursive: true });
	const ctx = buildMigrationContext({
		source: params.opts.source,
		includeSecrets: params.opts.includeSecrets,
		overwrite: params.opts.overwrite,
		runtime: params.runtime,
		backupPath,
		reportDir,
		json: params.opts.json
	});
	const result = await params.provider.apply(ctx, selectedPlan);
	const withBackup = {
		...result,
		backupPath: result.backupPath ?? backupPath,
		reportDir: result.reportDir ?? reportDir
	};
	writeApplyResult(params.runtime, params.opts, withBackup);
	assertApplySucceeded(withBackup);
	return withBackup;
}
//#endregion
export { runMigrationApply as n, createPreMigrationBackup as t };
