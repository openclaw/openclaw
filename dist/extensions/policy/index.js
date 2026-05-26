import { c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "../../agent-scope-config-CMp71_27.js";
import { u as readConfigFileSnapshot } from "../../io-DoswVvYe.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { i as parseHealthFindingSeverity, r as healthFindingMeetsSeverity, t as exitCodeFromFindings } from "../../doctor-lint-flow-Cb_9U00U.js";
import "../../health-B1sNnMi-.js";
import { i as createPolicyAttestation, n as evaluatePolicy, r as registerPolicyDoctorChecks, t as POLICY_CHECK_IDS } from "../../register-T7GpLv4c.js";
import { setTimeout } from "node:timers/promises";
//#region extensions/policy/src/cli.ts
const defaultRuntime = {
	writeStdout(value) {
		process.stdout.write(value);
	},
	error(value) {
		process.stderr.write(`${value}\n`);
	},
	sleep(ms) {
		return setTimeout(ms);
	}
};
function registerPolicyCli(program) {
	const policy = program.command("policy").description("Verify workspace policy conformance");
	policy.command("check").description("Check policy requirements and emit an audit attestation").option("--json", "Emit JSON output").option("--severity-min <severity>", "Minimum severity: info, warning, or error").action(async (options) => {
		process.exitCode = await policyCheckCommand(options);
	});
	policy.command("watch").description("Watch policy evidence and report accepted-attestation drift").option("--json", "Emit JSON output").option("--severity-min <severity>", "Minimum severity: info, warning, or error").option("--interval-ms <ms>", "Polling interval in milliseconds").option("--once", "Run one watch evaluation and exit").action(async (options) => {
		process.exitCode = await policyWatchCommand(options);
	});
}
async function policyCheckCommand(options, runtime = defaultRuntime) {
	try {
		const report = await buildPolicyCheckReport(options, runtime);
		writePolicyCheckReport(report, options, runtime);
		return report.exitCode;
	} catch (err) {
		runtime.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
}
async function policyWatchCommand(options, runtime = defaultRuntime) {
	try {
		const intervalMs = normalizeWatchIntervalMs(options.intervalMs);
		let previousKey;
		for (;;) {
			const report = await buildPolicyCheckReport(options, runtime);
			const status = policyWatchStatus(report);
			const key = `${status}:${report.attestation?.attestationHash ?? ""}:${report.exitCode}`;
			if (previousKey === void 0 || previousKey !== key || options.once === true) {
				writePolicyWatchReport(report, status, options, runtime);
				previousKey = key;
			}
			if (options.once === true) return status === "stale" ? 1 : report.exitCode;
			if (runtime.sleep !== void 0) await runtime.sleep(intervalMs);
			else await setTimeout(intervalMs);
		}
	} catch (err) {
		runtime.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
}
async function buildPolicyCheckReport(options, runtime) {
	const severityMin = options.severityMin === void 0 ? "info" : parseHealthFindingSeverity(options.severityMin);
	if (severityMin === null) throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
	const snapshot = await readConfigFileSnapshot({ observe: false });
	if (!snapshot.valid) {
		const visibleFindings = snapshot.issues.map((issue) => ({
			checkId: "policy/config-invalid",
			severity: "error",
			message: issue.message,
			source: "policy",
			path: issue.path
		})).filter((finding) => healthFindingMeetsSeverity(finding, severityMin));
		return {
			ok: visibleFindings.length === 0,
			evidence: { channels: [] },
			checksRun: 1,
			checksSkipped: POLICY_CHECK_IDS.length,
			findings: visibleFindings.map(toJsonFinding),
			exitCode: visibleFindings.length === 0 ? 0 : 1
		};
	}
	const cfg = snapshot.valid ? policyCommandConfig(snapshot.config) : {};
	const evaluation = await evaluatePolicy({
		mode: "lint",
		runtime: {
			log(value) {
				runtime.writeStdout(`${String(value)}\n`);
			},
			error(value) {
				runtime.error(String(value));
			},
			exit(code) {
				process.exitCode = code;
			}
		},
		cfg,
		cwd: options.cwd ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
		...snapshot.path !== void 0 ? { configPath: snapshot.path } : {}
	});
	const jsonFindings = evaluation.findings.filter((finding) => healthFindingMeetsSeverity(finding, severityMin)).map(toJsonFinding);
	const attestedFindings = evaluation.attestedFindings.map(toJsonFinding);
	return {
		ok: exitCodeFromFindings(evaluation.findings, severityMin) === 0,
		attestation: createPolicyAttestation({
			ok: evaluation.attestedFindings.length === 0,
			checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
			policyPath: evaluation.policyPath,
			policyHash: evaluation.policy?.hash,
			evidence: evaluation.evidence,
			findings: attestedFindings
		}),
		evidence: evaluation.evidence,
		checksRun: POLICY_CHECK_IDS.length,
		checksSkipped: 0,
		findings: jsonFindings,
		expectedAttestationHash: evaluation.expectedAttestationHash,
		exitCode: exitCodeFromFindings(evaluation.findings, severityMin)
	};
}
function policyCommandConfig(cfg) {
	return {
		...cfg,
		plugins: {
			...cfg.plugins,
			entries: {
				...cfg.plugins?.entries,
				policy: {
					...cfg.plugins?.entries?.["policy"],
					enabled: true,
					config: {
						enabled: true,
						...typeof cfg.plugins?.entries?.["policy"]?.config === "object" && cfg.plugins.entries["policy"].config !== null ? cfg.plugins.entries["policy"].config : {}
					}
				}
			}
		}
	};
}
function writePolicyCheckReport(report, options, runtime) {
	if (options.json === true || !process.stdout.isTTY) runtime.writeStdout(JSON.stringify({
		ok: report.ok,
		attestation: report.attestation,
		evidence: report.evidence,
		checksRun: report.checksRun,
		checksSkipped: report.checksSkipped,
		findings: report.findings
	}) + "\n");
	else if (report.findings.length === 0) {
		const policyHash = report.attestation?.policy?.hash ?? "missing";
		const evidenceHash = report.attestation?.workspace.hash ?? "unavailable";
		runtime.writeStdout(`policy check: no findings (policy ${policyHash}, evidence ${evidenceHash})\n`);
	} else {
		runtime.writeStdout(`policy check: ${report.findings.length} finding(s)\n`);
		for (const finding of report.findings) {
			const where = typeof finding.path === "string" ? ` ${finding.path}` : "";
			const line = typeof finding.line === "number" ? `:${finding.line}` : "";
			const severity = typeof finding.severity === "string" ? finding.severity : "unknown";
			const checkId = typeof finding.checkId === "string" ? finding.checkId : "unknown";
			const message = typeof finding.message === "string" ? finding.message : "";
			runtime.writeStdout(`  [${severity}] ${checkId}${where}${line} - ${message}\n`);
		}
	}
}
function writePolicyWatchReport(report, status, options, runtime) {
	if (options.json === true || !process.stdout.isTTY) {
		runtime.writeStdout(JSON.stringify({
			status,
			ok: report.ok,
			expectedAttestationHash: report.expectedAttestationHash,
			attestation: report.attestation,
			findings: report.findings
		}) + "\n");
		return;
	}
	if (status === "stale") {
		runtime.writeStdout(`policy watch: accepted attestation is stale (current ${report.attestation?.attestationHash}, expected ${report.expectedAttestationHash}). Review policy check output, then update the supervisor/gateway accepted attestation.\n`);
		return;
	}
	if (status === "findings") {
		runtime.writeStdout(`policy watch: ${report.findings.length} finding(s); accepted attestation cannot be updated until policy check is clean.\n`);
		return;
	}
	runtime.writeStdout(`policy watch: clean (attestation ${report.attestation?.attestationHash}, evidence ${report.attestation?.workspace.hash})\n`);
}
function policyWatchStatus(report) {
	if (!report.ok && report.findings.some((finding) => finding.checkId !== "policy/attestation-hash-mismatch")) return "findings";
	const expected = report.expectedAttestationHash?.trim();
	if (expected && report.attestation !== void 0 && report.attestation.attestationHash !== expected) return "stale";
	return report.ok ? "clean" : "findings";
}
function normalizeWatchIntervalMs(value) {
	const raw = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
	return Number.isFinite(raw) && raw >= 250 ? raw : 2e3;
}
function toJsonFinding(finding) {
	return {
		checkId: finding.checkId,
		severity: finding.severity,
		message: finding.message,
		...finding.source !== void 0 ? { source: finding.source } : {},
		...finding.path !== void 0 ? { path: finding.path } : {},
		...finding.line !== void 0 ? { line: finding.line } : {},
		...finding.ocPath !== void 0 ? { ocPath: finding.ocPath } : {},
		...finding.target !== void 0 ? { target: finding.target } : {},
		...finding.requirement !== void 0 ? { requirement: finding.requirement } : {},
		...finding.fixHint !== void 0 ? { fixHint: finding.fixHint } : {}
	};
}
//#endregion
//#region extensions/policy/index.ts
var policy_default = definePluginEntry({
	id: "policy",
	name: "Policy",
	description: "Adds policy-backed doctor checks for workspace conformance.",
	register(api) {
		api.registerCli(async ({ program }) => {
			registerPolicyCli(program);
		}, { descriptors: [{
			name: "policy",
			description: "Check policy requirements and emit audit evidence",
			hasSubcommands: true
		}] });
		registerPolicyDoctorChecks();
	}
});
//#endregion
export { policy_default as default };
