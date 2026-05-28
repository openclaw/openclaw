import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildCapitalLiveTradingApprovalSummary } from "./openclaw-capital-live-trading-approval-summary.mjs";

const repoRoot = process.cwd();
const stateDir = path.join(repoRoot, "reports", "hermes-agent", "state");
const summaryPath = path.join(
  stateDir,
  "openclaw-capital-live-trading-approval-summary-latest.json",
);
const publishReportPath = path.join(
  stateDir,
  "openclaw-capital-live-trading-approval-telegram-publish-dry-run-latest.json",
);

function runNode(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      }),
    );
    child.once("error", (error) =>
      resolve({
        exitCode: 1,
        stdout: stdout.join(""),
        stderr: `${stderr.join("")}\n${error.message}`.trim(),
      }),
    );
  });
}

const summary = await buildCapitalLiveTradingApprovalSummary({
  writeGateState: true,
});
await fs.mkdir(stateDir, { recursive: true });
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const result = await runNode(
  [
    "scripts/openclaw-controlled-task-runner-telegram-publish.mjs",
    "--dry-run",
    "--summary",
    summaryPath,
    "--report",
    publishReportPath,
  ],
  {
    OPENCLAW_TELEGRAM_STATUS_TARGET: "capital-approval-dry-run-target",
  },
);

assert.equal(result.exitCode, 0, result.stderr || result.stdout);

const publishReport = JSON.parse(await fs.readFile(publishReportPath, "utf8"));
assert.equal(publishReport.schema, "openclaw.controlled-task-runner.telegram-publish.report.v1");
assert.equal(publishReport.status, "dry_run_ok");
assert.equal(publishReport.dryRun, true);
assert.equal(publishReport.dryRunNoSend, true);
assert.equal(publishReport.commandExitCode, 0);
assert.equal(publishReport.commandErrorCode, "DRY_RUN_NO_SEND");
assert.equal(publishReport.target, "capital-approval-dry-run-target");
assert.equal(publishReport.targetSource, "env");
assert.match(
  publishReport.summaryPath,
  /openclaw-capital-live-trading-approval-summary-latest\.json/u,
);
assert.match(
  publishReport.reportPath,
  /openclaw-capital-live-trading-approval-telegram-publish-dry-run-latest\.json/u,
);
assert.match(publishReport.message, /群益真單=(封鎖|已開啟)/u);
assert.match(publishReport.message, /humanApproved=(true|false)/u);
assert.match(publishReport.message, /accountAllowlist=[1-9][0-9]*/u);
assert.match(publishReport.message, /live\/write\/order=(OFF|ON)/u);
if (summary.status === "live_enabled_manual_window") {
  assert.match(publishReport.message, /blockers=none/u);
}

process.stdout.write(
  [
    "CAPITAL_LIVE_TRADING_APPROVAL_TELEGRAM_PUBLISH_CHECK=OK",
    `status=${publishReport.status}`,
    `dryRunNoSend=${publishReport.dryRunNoSend}`,
    `targetSource=${publishReport.targetSource}`,
    `message=${publishReport.message}`,
  ].join("\n") + "\n",
);
