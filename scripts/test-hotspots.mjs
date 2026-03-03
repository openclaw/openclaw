import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    config: "vitest.unit.config.ts",
    limit: 20,
    reportPath: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      args.config = argv[i + 1] ?? args.config;
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.limit = parsed;
      }
      i += 1;
      continue;
    }
    if (arg === "--report") {
      args.reportPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
  }
  return args;
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

const opts = parseArgs(process.argv.slice(2));
const reportPath =
  opts.reportPath || path.join(os.tmpdir(), `openclaw-vitest-hotspots-${Date.now()}.json`);

if (!(opts.reportPath && fs.existsSync(reportPath))) {
  const run = spawnSync(
    "pnpm",
    ["vitest", "run", "--config", opts.config, "--reporter=json", "--outputFile", reportPath],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const fileResults = (report.testResults ?? [])
  .map((result) => {
    const start = typeof result.startTime === "number" ? result.startTime : 0;
    const end = typeof result.endTime === "number" ? result.endTime : 0;
    const testCount = Array.isArray(result.assertionResults) ? result.assertionResults.length : 0;
    return {
      file: typeof result.name === "string" ? result.name : "unknown",
      durationMs: Math.max(0, end - start),
      testCount,
    };
  })
  .toSorted((a, b) => b.durationMs - a.durationMs);

const top = fileResults.slice(0, opts.limit);
const totalDurationMs = fileResults.reduce((sum, item) => sum + item.durationMs, 0);
console.log(
  `\n[test-hotspots] top ${String(top.length)} by file duration (${formatMs(totalDurationMs)} total)`,
);
for (const [index, item] of top.entries()) {
  const label = String(index + 1).padStart(2, " ");
  const duration = formatMs(item.durationMs).padStart(10, " ");
  const tests = String(item.testCount).padStart(4, " ");
  console.log(`${label}. ${duration} | tests=${tests} | ${item.file}`);
}
