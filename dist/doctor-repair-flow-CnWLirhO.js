import { r as listHealthChecks } from "./health-check-registry-DxXQHCTW.js";
import { t as scrubDoctorErrorMessage } from "./doctor-error-message-CwwwI8gS.js";
//#region src/flows/doctor-repair-flow.ts
async function runDoctorHealthRepairs(ctx, opts = {}) {
	const checks = opts.checks ?? listHealthChecks();
	const findings = [];
	const remainingFindings = [];
	const changes = [];
	const warnings = [];
	const diffs = [];
	const effects = [];
	let cfg = ctx.cfg;
	let checksRepaired = 0;
	let checksValidated = 0;
	for (const check of checks) {
		const detectCtx = {
			...ctx,
			cfg
		};
		let checkFindings;
		try {
			checkFindings = await check.detect(detectCtx);
		} catch (err) {
			warnings.push(`${check.id} detect failed: ${scrubDoctorErrorMessage(err)}`);
			continue;
		}
		findings.push(...checkFindings);
		if (checkFindings.length === 0 || check.repair === void 0) continue;
		try {
			const result = await check.repair({
				...ctx,
				cfg,
				dryRun: opts.dryRun === true,
				diff: opts.diff === true
			}, checkFindings);
			warnings.push(...result.warnings ?? []);
			diffs.push(...result.diffs ?? []);
			effects.push(...result.effects ?? []);
			const status = result.status ?? "repaired";
			if (status !== "repaired") {
				warnings.push(`${check.id} repair ${status}${result.reason ? `: ${result.reason}` : ""}`);
				continue;
			}
			if (result.config !== void 0 && opts.dryRun !== true) cfg = result.config;
			changes.push(...result.changes);
			checksRepaired++;
			if (opts.dryRun === true) continue;
			try {
				const validationFindings = await check.detect({
					...ctx,
					cfg
				}, createValidationScope(checkFindings));
				remainingFindings.push(...validationFindings);
				checksValidated++;
				if (validationFindings.length > 0) warnings.push(`${check.id} repair left ${validationFindings.length} finding(s)`);
			} catch (err) {
				warnings.push(`${check.id} validation failed: ${scrubDoctorErrorMessage(err)}`);
			}
		} catch (err) {
			warnings.push(`${check.id} repair failed: ${scrubDoctorErrorMessage(err)}`);
		}
	}
	return {
		config: cfg,
		findings,
		remainingFindings,
		changes,
		warnings,
		diffs,
		effects,
		checksRun: checks.length,
		checksRepaired,
		checksValidated
	};
}
function createValidationScope(findings) {
	return {
		findings,
		paths: uniqueDefined(findings.map((finding) => finding.path)),
		ocPaths: uniqueDefined(findings.map((finding) => finding.ocPath))
	};
}
function uniqueDefined(values) {
	return [...new Set(values.filter((value) => value !== void 0))];
}
//#endregion
export { runDoctorHealthRepairs };
