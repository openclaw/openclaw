import "./agent-scope-rw2bYM9R.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-DdvF1onI.js";
import { u as readConfigFileSnapshot } from "./io-DxVmbF3R.js";
import "./config-CBeYX-pH.js";
import { a as configValidationIssuesToHealthFindings, i as parseHealthFindingSeverity, n as runDoctorLintChecks, o as registerCoreHealthChecks, r as healthFindingMeetsSeverity, t as exitCodeFromFindings } from "./doctor-lint-flow-B-q0RE7m.js";
//#region src/commands/doctor-lint.ts
function detectMode(opts) {
	if (opts.json === true) return "json";
	return process.stdout.isTTY ? "human" : "json";
}
async function runDoctorLintCli(runtime, opts) {
	registerCoreHealthChecks();
	const sevMin = opts.severityMin === void 0 ? "info" : parseHealthFindingSeverity(opts.severityMin);
	if (sevMin === null) throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
	const snapshot = await readConfigFileSnapshot();
	if (snapshot.exists && !snapshot.valid) {
		const findings = configValidationIssuesToHealthFindings(snapshot.issues);
		const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
		if (detectMode(opts) === "json") writeJsonResult({
			ok: false,
			checksRun: 1,
			checksSkipped: 0,
			findings: visible
		});
		else {
			runtime.error("doctor --lint: config file exists but does not parse cleanly.");
			for (const issue of snapshot.issues) {
				const path = issue.path || "<root>";
				runtime.error(`- ${path}: ${issue.message}`);
			}
		}
		return exitCodeFromFindings(findings, sevMin);
	}
	const result = await runDoctorLintChecks({
		mode: "lint",
		runtime,
		cfg: snapshot.config,
		cwd: resolveAgentWorkspaceDir(snapshot.config, resolveDefaultAgentId(snapshot.config)),
		...snapshot.path !== void 0 ? { configPath: snapshot.path } : {}
	}, {
		...opts.skipIds && opts.skipIds.length > 0 ? { skipIds: opts.skipIds } : {},
		...opts.onlyIds && opts.onlyIds.length > 0 ? { onlyIds: opts.onlyIds } : {}
	});
	const visible = result.findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
	if (detectMode(opts) === "json") writeJsonResult({
		ok: exitCodeFromFindings(result.findings, sevMin) === 0,
		checksRun: result.checksRun,
		checksSkipped: result.checksSkipped,
		findings: visible
	});
	else {
		process.stdout.write(`doctor --lint: ran ${result.checksRun} check(s), ${visible.length} finding(s)\n`);
		if (visible.length === 0) process.stdout.write("  no findings\n");
		else for (const f of visible) {
			const where = f.path !== void 0 ? ` ${f.path}` : "";
			const line = f.line !== void 0 ? `:${f.line}` : "";
			process.stdout.write(`  [${f.severity}] ${f.checkId}${where}${line} - ${f.message}\n`);
			if (f.fixHint !== void 0) process.stdout.write(`    fix: ${f.fixHint}\n`);
		}
	}
	return exitCodeFromFindings(result.findings, sevMin);
}
function writeJsonResult(result) {
	process.stdout.write(JSON.stringify({
		ok: result.ok,
		checksRun: result.checksRun,
		checksSkipped: result.checksSkipped,
		findings: result.findings.map(toJsonFinding)
	}) + "\n");
}
function toJsonFinding(f) {
	return {
		checkId: f.checkId,
		severity: f.severity,
		message: f.message,
		...f.source !== void 0 ? { source: f.source } : {},
		...f.path !== void 0 ? { path: f.path } : {},
		...f.line !== void 0 ? { line: f.line } : {},
		...f.column !== void 0 ? { column: f.column } : {},
		...f.ocPath !== void 0 ? { ocPath: f.ocPath } : {},
		...f.fixHint !== void 0 ? { fixHint: f.fixHint } : {}
	};
}
//#endregion
export { runDoctorLintCli };
