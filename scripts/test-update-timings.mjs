import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unitTimingManifestPath } from "./test-runner-manifest.mjs";

function parseArgs(argv) {
  const args = {
    config: "vitest.unit.config.ts",
    out: unitTimingManifestPath,
    reportPath: "",
    limit: 128,
    defaultDurationMs: 250,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      args.config = argv[i + 1] ?? args.config;
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.out = argv[i + 1] ?? args.out;
      i += 1;
      continue;
    }
    if (arg === "--report") {
      args.reportPath = argv[i + 1] ?? "";
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
    if (arg === "--default-duration-ms") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.defaultDurationMs = parsed;
      }
      i += 1;
      continue;
    }
  }
  return args;
}

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const opts = parseArgs(process.argv.slice(2));
const reportPath =
  opts.reportPath || path.join(os.tmpdir(), `openclaw-vitest-timings-${Date.now()}.json`);

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
const files = Object.fromEntries(
  (report.testResults ?? [])
    .map((result) => {
      const file = typeof result.name === "string" ? normalizeRepoPath(result.name) : "";
      const start = typeof result.startTime === "number" ? result.startTime : 0;
      const end = typeof result.endTime === "number" ? result.endTime : 0;
      const testCount = Array.isArray(result.assertionResults) ? result.assertionResults.length : 0;
      return {
        file,
        durationMs: Math.max(0, end - start),
        testCount,
      };
    })
    .filter((entry) => entry.file.length > 0 && entry.durationMs > 0)
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, opts.limit)
    .map((entry) => [
      entry.file,
      {
        durationMs: entry.durationMs,
        testCount: entry.testCount,
      },
    ]),
);

const output = {
  config: opts.config,
  generatedAt: new Date().toISOString(),
  defaultDurationMs: opts.defaultDurationMs,
  files,
};

fs.writeFileSync(opts.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `[test-update-timings] wrote ${String(Object.keys(files).length)} timings to ${opts.out}`,
);
