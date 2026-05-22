import "./agent-scope-Bl5pjInQ.js";
import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-Dm11aCiH.js";
import { u as readConfigFileSnapshot } from "./io-CmeoeBvq.js";
import "./config-B3BdVqTi.js";
import { n as registerCoreHealthChecks, t as configValidationIssuesToHealthFindings } from "./doctor-core-checks-i1KvhLkN.js";
import { i as parseHealthFindingSeverity, n as runDoctorLintChecks, r as healthFindingMeetsSeverity, t as exitCodeFromFindings } from "./doctor-lint-flow-BYFq29TI.js";
import { t as registerBundledHealthChecks } from "./bundled-health-checks-C0kdFlKs.js";
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
	const ctx = {
		mode: "lint",
		runtime,
		cfg: snapshot.config,
		cwd: resolveAgentWorkspaceDir(snapshot.config, resolveDefaultAgentId(snapshot.config)),
		...snapshot.path !== void 0 ? { configPath: snapshot.path } : {}
	};
	registerBundledHealthChecks({
		cfg: snapshot.config,
		cwd: ctx.cwd
	});
	const result = await runDoctorLintChecks(ctx, {
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
		...f.target !== void 0 ? { target: f.target } : {},
		...f.requirement !== void 0 ? { requirement: f.requirement } : {},
		...f.fixHint !== void 0 ? { fixHint: f.fixHint } : {}
	};
}
//#endregion
export { runDoctorLintCli };
