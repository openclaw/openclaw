import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const checks = [
  "check-capital-live-trading-operator-gate.mjs",
  "check-capital-live-trading-operator-auto-activate.mjs",
  "check-capital-live-trading-operator-auto-deactivate.mjs",
  "check-capital-live-trading-operator-auto-reconcile.mjs",
  "check-capital-live-trading-operator-auto-guard.mjs",
  "check-capital-live-trading-operator-heartbeat-runner.mjs",
];

const failures = [];
const passed = [];

for (const checkFile of checks) {
  const scriptPath = path.join(repoRoot, "scripts", checkFile);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push({
      check: checkFile,
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    });
    continue;
  }
  const lastLine =
    (result.stdout || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.length > 0) || "";
  passed.push({ check: checkFile, summary: lastLine });
}

if (failures.length > 0) {
  process.stderr.write("CAPITAL_LIVE_TRADING_OPERATOR_SURFACE_CHECK=FAIL\n");
  for (const item of failures) {
    process.stderr.write(`check=${item.check} status=${item.status}\n`);
    if (item.stdout.trim()) {
      process.stderr.write(`stdout=${item.stdout.trim()}\n`);
    }
    if (item.stderr.trim()) {
      process.stderr.write(`stderr=${item.stderr.trim()}\n`);
    }
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    [
      "CAPITAL_LIVE_TRADING_OPERATOR_SURFACE_CHECK=OK",
      ...passed.map((item) => `${item.check} ${item.summary}`),
    ].join("\n") + "\n",
  );
}
