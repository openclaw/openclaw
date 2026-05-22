import { r as listHealthChecks } from "./health-check-registry-DxXQHCTW.js";
import { t as scrubDoctorErrorMessage } from "./doctor-error-message-CwwwI8gS.js";
//#region src/flows/health-checks.ts
const HEALTH_FINDING_SEVERITY_RANK = {
	info: 0,
	warning: 1,
	error: 2
};
function parseHealthFindingSeverity(input) {
	if (input === "info" || input === "warning" || input === "error") return input;
	return null;
}
function healthFindingMeetsSeverity(finding, severityMin) {
	return HEALTH_FINDING_SEVERITY_RANK[finding.severity] >= HEALTH_FINDING_SEVERITY_RANK[severityMin];
}
//#endregion
//#region src/flows/doctor-lint-flow.ts
async function runDoctorLintChecks(ctx, opts = {}) {
	const all = opts.checks ?? listHealthChecks();
	const skip = opts.skipIds instanceof Set ? opts.skipIds : new Set(opts.skipIds ?? []);
	const only = opts.onlyIds instanceof Set ? opts.onlyIds : new Set(opts.onlyIds ?? []);
	const allIds = new Set(all.map((check) => check.id));
	const selected = all.filter((c) => {
		if (only.size > 0 && !only.has(c.id)) return false;
		if (skip.has(c.id)) return false;
		return true;
	});
	const findings = [];
	for (const id of only) if (!allIds.has(id)) findings.push({
		checkId: "core/doctor/lint-selection",
		severity: "error",
		message: `Unknown health check id selected by --only: ${id}.`,
		path: id
	});
	for (const check of selected) try {
		const out = await check.detect(ctx);
		for (const f of out) findings.push(f);
	} catch (err) {
		findings.push({
			checkId: check.id,
			severity: "error",
			message: `health check threw: ${scrubDoctorErrorMessage(err)}`
		});
	}
	findings.sort(compareFindings);
	return {
		findings,
		checksRun: selected.length,
		checksSkipped: all.length - selected.length
	};
}
function compareFindings(a, b) {
	const sevDelta = HEALTH_FINDING_SEVERITY_RANK[b.severity] - HEALTH_FINDING_SEVERITY_RANK[a.severity];
	if (sevDelta !== 0) return sevDelta;
	const idDelta = a.checkId.localeCompare(b.checkId);
	if (idDelta !== 0) return idDelta;
	return (a.path ?? "").localeCompare(b.path ?? "");
}
function exitCodeFromFindings(findings, severityMin = "warning") {
	return findings.some((f) => healthFindingMeetsSeverity(f, severityMin)) ? 1 : 0;
}
//#endregion
export { parseHealthFindingSeverity as i, runDoctorLintChecks as n, healthFindingMeetsSeverity as r, exitCodeFromFindings as t };
