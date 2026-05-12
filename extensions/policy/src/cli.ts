import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import {
  exitCodeFromFindings,
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  readConfigFileSnapshot,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { POLICY_CHECK_IDS, evaluatePolicy } from "./doctor/register.js";
import { createPolicyAttestation } from "./policy-state.js";

export type PolicyCommandRuntime = {
  writeStdout(value: string): void;
  error(value: string): void;
  sleep?(ms: number): Promise<void>;
};

export interface PolicyCheckOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly cwd?: string;
}

export interface PolicyWatchOptions extends PolicyCheckOptions {
  readonly intervalMs?: string | number;
  readonly once?: boolean;
}

type PolicyCheckReport = {
  readonly ok: boolean;
  readonly attestation: ReturnType<typeof createPolicyAttestation>;
  readonly evidence: unknown;
  readonly checksRun: number;
  readonly checksSkipped: number;
  readonly findings: readonly Record<string, unknown>[];
  readonly expectedAttestationHash?: string;
  readonly exitCode: 0 | 1;
};

const defaultRuntime: PolicyCommandRuntime = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
  },
  sleep(ms) {
    return sleep(ms);
  },
};

export function registerPolicyCli(program: Command): void {
  const policy = program.command("policy").description("Verify workspace policy conformance");

  policy
    .command("check")
    .description("Check policy requirements and emit an audit attestation")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .action(async (options: PolicyCheckOptions) => {
      process.exitCode = await policyCheckCommand(options);
    });

  policy
    .command("watch")
    .description("Watch policy evidence and report accepted-attestation drift")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .option("--interval-ms <ms>", "Polling interval in milliseconds")
    .option("--once", "Run one watch evaluation and exit")
    .action(async (options: PolicyWatchOptions) => {
      process.exitCode = await policyWatchCommand(options);
    });
}

export async function policyCheckCommand(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  const report = await buildPolicyCheckReport(options, runtime);
  writePolicyCheckReport(report, options, runtime);
  return report.exitCode;
}

export async function policyWatchCommand(
  options: PolicyWatchOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  const intervalMs = normalizeWatchIntervalMs(options.intervalMs);
  let previousKey: string | undefined;
  do {
    const report = await buildPolicyCheckReport(options, runtime);
    const status = policyWatchStatus(report);
    const key = `${status}:${report.attestation.attestationHash ?? ""}:${report.exitCode}`;
    if (previousKey === undefined || previousKey !== key || options.once === true) {
      writePolicyWatchReport(report, status, options, runtime);
      previousKey = key;
    }
    if (options.once === true) {
      return status === "stale" ? 1 : report.exitCode;
    }
    await (runtime.sleep ?? sleep)(intervalMs);
  } while (true);
}

async function buildPolicyCheckReport(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime,
): Promise<PolicyCheckReport> {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const cwd = options.cwd ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const ctx: HealthCheckContext = {
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
      },
    },
    cfg,
    cwd,
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };
  const evaluation = await evaluatePolicy(ctx);
  const severityMin =
    options.severityMin === undefined ? "info" : parseHealthFindingSeverity(options.severityMin);
  if (severityMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  const findings = evaluation.findings.filter((finding) =>
    healthFindingMeetsSeverity(finding, severityMin),
  );
  const jsonFindings = findings.map(toJsonFinding);
  const attestedFindings = jsonFindings.filter(
    (finding) => finding.checkId !== "policy/attestation-hash-mismatch",
  );
  const ok = exitCodeFromFindings(evaluation.findings, severityMin) === 0;
  const attestation = createPolicyAttestation({
    ok: attestedFindings.length === 0,
    checkedAt: new Date().toISOString(),
    policyPath: evaluation.policyPath,
    policyHash: evaluation.policy?.hash,
    evidence: evaluation.evidence,
    findings: attestedFindings,
  });
  return {
    ok,
    attestation,
    evidence: evaluation.evidence,
    checksRun: POLICY_CHECK_IDS.length,
    checksSkipped: 0,
    findings: jsonFindings,
    expectedAttestationHash: evaluation.expectedAttestationHash,
    exitCode: exitCodeFromFindings(evaluation.findings, severityMin),
  };
}

function writePolicyCheckReport(
  report: PolicyCheckReport,
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(
      JSON.stringify({
        ok: report.ok,
        attestation: report.attestation,
        evidence: report.evidence,
        checksRun: report.checksRun,
        checksSkipped: report.checksSkipped,
        findings: report.findings,
      }) + "\n",
    );
  } else if (report.findings.length === 0) {
    runtime.writeStdout(
      `policy check: no findings (policy ${report.attestation.policy?.hash ?? "missing"}, evidence ${report.attestation.workspace.hash})\n`,
    );
  } else {
    runtime.writeStdout(`policy check: ${report.findings.length} finding(s)\n`);
    for (const finding of report.findings) {
      const where = typeof finding.path === "string" ? ` ${finding.path}` : "";
      const line = typeof finding.line === "number" ? `:${finding.line}` : "";
      runtime.writeStdout(
        `  [${finding.severity}] ${finding.checkId}${where}${line} - ${finding.message}\n`,
      );
    }
  }
}

function writePolicyWatchReport(
  report: PolicyCheckReport,
  status: "clean" | "findings" | "stale",
  options: PolicyWatchOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(
      JSON.stringify({
        status,
        ok: report.ok,
        expectedAttestationHash: report.expectedAttestationHash,
        attestation: report.attestation,
        findings: report.findings,
      }) + "\n",
    );
    return;
  }
  if (status === "stale") {
    runtime.writeStdout(
      `policy watch: accepted attestation is stale (current ${report.attestation.attestationHash}, expected ${report.expectedAttestationHash}). Review policy check output, then update the supervisor/gateway accepted attestation.\n`,
    );
    return;
  }
  if (status === "findings") {
    runtime.writeStdout(
      `policy watch: ${report.findings.length} finding(s); accepted attestation cannot be updated until policy check is clean.\n`,
    );
    return;
  }
  runtime.writeStdout(
    `policy watch: clean (attestation ${report.attestation.attestationHash}, evidence ${report.attestation.workspace.hash})\n`,
  );
}

function policyWatchStatus(report: PolicyCheckReport): "clean" | "findings" | "stale" {
  const expected = report.expectedAttestationHash?.trim();
  if (expected && report.attestation.attestationHash !== expected) {
    return "stale";
  }
  return report.ok ? "clean" : "findings";
}

function normalizeWatchIntervalMs(value: string | number | undefined): number {
  const raw = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(raw) && raw >= 250 ? raw : 2000;
}

function toJsonFinding(finding: HealthFinding): Record<string, unknown> {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.ocPath !== undefined ? { ocPath: finding.ocPath } : {}),
    ...(finding.target !== undefined ? { target: finding.target } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}
