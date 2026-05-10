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
import {
  policyAttestationHash,
  policyFindingsHash,
  policyWorkspaceHash,
  type PolicyAttestation,
} from "./policy-state.js";

export type PolicyCommandRuntime = {
  writeStdout(value: string): void;
  error(value: string): void;
};

export interface PolicyCheckOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly cwd?: string;
}

const defaultRuntime: PolicyCommandRuntime = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
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
}

export async function policyCheckCommand(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
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
  const severityMin = parseHealthFindingSeverity(options.severityMin) ?? "info";
  const findings = evaluation.findings.filter((finding) =>
    healthFindingMeetsSeverity(finding, severityMin),
  );
  const jsonFindings = findings.map(toJsonFinding);
  const ok = exitCodeFromFindings(evaluation.findings, severityMin) === 0;
  const checkedAt = new Date().toISOString();
  const findingsHash = policyFindingsHash(jsonFindings);
  const workspaceHash = policyWorkspaceHash(evaluation.evidence);
  const attestation: PolicyAttestation = {
    checkedAt,
    ...(evaluation.policy === undefined
      ? {}
      : {
          policy: {
            path: evaluation.policyPath,
            hash: evaluation.policy.hash,
          },
        }),
    workspace: {
      scope: "channels",
      hash: workspaceHash,
    },
    findingsHash,
    attestationHash: policyAttestationHash({
      ok,
      checkedAt,
      policyHash: evaluation.policy?.hash,
      workspaceHash,
      findingsHash,
    }),
  };

  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(
      JSON.stringify({
        ok,
        attestation,
        evidence: evaluation.evidence,
        checksRun: POLICY_CHECK_IDS.length,
        checksSkipped: 0,
        findings: jsonFindings,
      }) + "\n",
    );
  } else if (findings.length === 0) {
    runtime.writeStdout(
      `policy check: no findings (policy ${attestation.policy?.hash ?? "missing"}, workspace ${attestation.workspace.hash})\n`,
    );
  } else {
    runtime.writeStdout(`policy check: ${findings.length} finding(s)\n`);
    for (const finding of findings) {
      const where = finding.path !== undefined ? ` ${finding.path}` : "";
      const line = finding.line !== undefined ? `:${finding.line}` : "";
      runtime.writeStdout(
        `  [${finding.severity}] ${finding.checkId}${where}${line} - ${finding.message}\n`,
      );
    }
  }

  return exitCodeFromFindings(evaluation.findings, severityMin);
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
