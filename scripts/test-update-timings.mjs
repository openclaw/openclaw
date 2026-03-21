import {
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
  readJsonFile,
  runVitestJsonReport,
  writeJsonFile,
} from "./test-report-utils.mjs";
import { unitTimingManifestPath } from "./test-runner-manifest.mjs";

function parseArgs(argv) {
  const args = {
    config: "vitest.unit.config.ts",
    out: unitTimingManifestPath,
    reportPath: "",
    limit: 256,
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

const opts = parseArgs(process.argv.slice(2));
const reportPath = runVitestJsonReport({
  config: opts.config,
  reportPath: opts.reportPath,
  prefix: "openclaw-vitest-timings",
});
const report = readJsonFile(reportPath);
const files = Object.fromEntries(
  collectVitestFileDurations(report, normalizeTrackedRepoPath)
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

writeJsonFile(opts.out, output);
console.log(
  `[test-update-timings] wrote ${String(Object.keys(files).length)} timings to ${opts.out}`,
);
