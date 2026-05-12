import { promises as fs } from "node:fs";
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

export interface PolicyDiffOptions {
  readonly json?: boolean;
}

type PolicyCheckReport = {
  readonly ok: boolean;
  readonly attestation?: ReturnType<typeof createPolicyAttestation>;
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

  policy
    .command("diff")
    .description("Compare two policy check JSON outputs")
    .argument("<before>", "Earlier policy check JSON output")
    .argument("<after>", "Later policy check JSON output")
    .option("--json", "Emit JSON output")
    .action(async (before: string, after: string, options: PolicyDiffOptions) => {
      process.exitCode = await policyDiffCommand(before, after, options);
    });
}

export async function policyCheckCommand(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const report = await buildPolicyCheckReport(options, runtime);
    writePolicyCheckReport(report, options, runtime);
    return report.exitCode;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function policyWatchCommand(
  options: PolicyWatchOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  const intervalMs = normalizeWatchIntervalMs(options.intervalMs);
  let previousKey: string | undefined;
  for (;;) {
    const report = await buildPolicyCheckReport(options, runtime);
    const status = policyWatchStatus(report);
    const key = `${status}:${report.attestation?.attestationHash ?? ""}:${report.exitCode}`;
    if (previousKey === undefined || previousKey !== key || options.once === true) {
      writePolicyWatchReport(report, status, options, runtime);
      previousKey = key;
    }
    if (options.once === true) {
      return status === "stale" ? 1 : report.exitCode;
    }
    if (runtime.sleep !== undefined) {
      await runtime.sleep(intervalMs);
    } else {
      await sleep(intervalMs);
    }
  }
}

export async function policyDiffCommand(
  beforePath: string,
  afterPath: string,
  options: PolicyDiffOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  const before = await readPolicyCheckOutput(beforePath);
  const after = await readPolicyCheckOutput(afterPath);
  const diff = buildPolicyDiff(before, after);
  writePolicyDiffReport(diff, options, runtime);
  return diff.changed.length === 0 ? 0 : 1;
}

async function buildPolicyCheckReport(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime,
): Promise<PolicyCheckReport> {
  const severityMin =
    options.severityMin === undefined ? "info" : parseHealthFindingSeverity(options.severityMin);
  if (severityMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (!snapshot.valid) {
    const findings: HealthFinding[] = snapshot.issues.map((issue) => ({
      checkId: "policy/config-invalid",
      severity: "error",
      message: issue.message,
      source: "policy",
      path: issue.path,
    }));
    const visibleFindings = findings.filter((finding) =>
      healthFindingMeetsSeverity(finding, severityMin),
    );
    return {
      ok: visibleFindings.length === 0,
      evidence: { channels: [] },
      checksRun: 1,
      checksSkipped: POLICY_CHECK_IDS.length,
      findings: visibleFindings.map(toJsonFinding),
      exitCode: visibleFindings.length === 0 ? 0 : 1,
    };
  }
  const cfg = policyCommandConfig(snapshot.config);
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
  const findings = evaluation.findings.filter((finding) =>
    healthFindingMeetsSeverity(finding, severityMin),
  );
  const jsonFindings = findings.map(toJsonFinding);
  const attestedFindings = evaluation.attestedFindings.map(toJsonFinding);
  const ok = exitCodeFromFindings(evaluation.findings, severityMin) === 0;
  const attestation = createPolicyAttestation({
    ok: evaluation.attestedFindings.length === 0,
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

function policyCommandConfig(cfg: HealthCheckContext["cfg"]): HealthCheckContext["cfg"] {
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
            ...(typeof cfg.plugins?.entries?.["policy"]?.config === "object" &&
            cfg.plugins.entries["policy"].config !== null
              ? cfg.plugins.entries["policy"].config
              : {}),
          },
        },
      },
    },
  };
}

type PolicyDiffReport = {
  readonly changed: readonly string[];
  readonly before: PolicyDiffSnapshot;
  readonly after: PolicyDiffSnapshot;
};

type PolicyDiffSnapshot = {
  readonly ok?: boolean;
  readonly policyHash?: string;
  readonly evidenceHash?: string;
  readonly findingsHash?: string;
  readonly attestationHash?: string;
  readonly checkedAt?: string;
};

function buildPolicyDiff(before: unknown, after: unknown): PolicyDiffReport {
  const beforeSnapshot = policyDiffSnapshot(before);
  const afterSnapshot = policyDiffSnapshot(after);
  const changed = [
    ...changedField(beforeSnapshot, afterSnapshot, "ok", "result"),
    ...changedField(beforeSnapshot, afterSnapshot, "policyHash", "policy"),
    ...changedField(beforeSnapshot, afterSnapshot, "evidenceHash", "evidence"),
    ...changedField(beforeSnapshot, afterSnapshot, "findingsHash", "findings"),
    ...changedField(beforeSnapshot, afterSnapshot, "attestationHash", "attestation"),
  ];
  return {
    changed,
    before: beforeSnapshot,
    after: afterSnapshot,
  };
}

function changedField(
  before: PolicyDiffSnapshot,
  after: PolicyDiffSnapshot,
  key: keyof PolicyDiffSnapshot,
  label: string,
): readonly string[] {
  return before[key] === after[key] ? [] : [label];
}

function policyDiffSnapshot(value: unknown): PolicyDiffSnapshot {
  if (!isRecord(value)) {
    return {};
  }
  const attestation = isRecord(value.attestation) ? value.attestation : {};
  const policy = isRecord(attestation.policy) ? attestation.policy : {};
  const workspace = isRecord(attestation.workspace) ? attestation.workspace : {};
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof policy.hash === "string" ? { policyHash: policy.hash } : {}),
    ...(typeof workspace.hash === "string" ? { evidenceHash: workspace.hash } : {}),
    ...(typeof attestation.findingsHash === "string"
      ? { findingsHash: attestation.findingsHash }
      : {}),
    ...(typeof attestation.attestationHash === "string"
      ? { attestationHash: attestation.attestationHash }
      : {}),
    ...(typeof attestation.checkedAt === "string" ? { checkedAt: attestation.checkedAt } : {}),
  };
}

async function readPolicyCheckOutput(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, "utf-8"));
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
    const policyHash = report.attestation?.policy?.hash ?? "missing";
    const evidenceHash = report.attestation?.workspace.hash ?? "unavailable";
    runtime.writeStdout(
      `policy check: no findings (policy ${policyHash}, evidence ${evidenceHash})\n`,
    );
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

function writePolicyDiffReport(
  report: PolicyDiffReport,
  options: PolicyDiffOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(JSON.stringify(report) + "\n");
    return;
  }
  if (report.changed.length === 0) {
    runtime.writeStdout(
      `policy diff: no drift (attestation ${report.after.attestationHash ?? "missing"})\n`,
    );
    return;
  }
  runtime.writeStdout(`policy diff: changed ${report.changed.join(", ")}\n`);
  runtime.writeStdout(
    `  before: attestation ${report.before.attestationHash ?? "missing"}, evidence ${report.before.evidenceHash ?? "missing"}\n`,
  );
  runtime.writeStdout(
    `  after:  attestation ${report.after.attestationHash ?? "missing"}, evidence ${report.after.evidenceHash ?? "missing"}\n`,
  );
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
      `policy watch: accepted attestation is stale (current ${report.attestation?.attestationHash ?? "missing"}, expected ${report.expectedAttestationHash}). Review policy check output, then update the supervisor/gateway accepted attestation.\n`,
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
    `policy watch: clean (attestation ${report.attestation?.attestationHash ?? "missing"}, evidence ${report.attestation?.workspace.hash ?? "unavailable"})\n`,
  );
}

function policyWatchStatus(report: PolicyCheckReport): "clean" | "findings" | "stale" {
  const expected = report.expectedAttestationHash?.trim();
  if (expected && report.attestation !== undefined && report.attestation.attestationHash !== expected) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
