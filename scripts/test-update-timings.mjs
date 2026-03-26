import { intFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { loadVitestReportFromArgs } from "./lib/vitest-report-cli-utils.mjs";
import {
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
  writeJsonFile,
} from "./test-report-utils.mjs";
import { unitTimingManifestPath } from "./test-runner-manifest.mjs";

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-update-timings.mjs [options]",
      "",
      "Generate or refresh the unit test timing manifest from a Vitest JSON report.",
      "",
      "Options:",
      "  --config <path>                Vitest config to run when no report is supplied",
      "  --report <path>                Reuse an existing Vitest JSON report",
      "  --out <path>                   Output manifest path (default: test/fixtures/test-timings.unit.json)",
      "  --limit <count>                Max number of file timings to retain (default: 256)",
      "  --default-duration-ms <ms>     Fallback duration for unknown files (default: 250)",
      "  --help                         Show this help text",
      "",
      "Examples:",
      "  node scripts/test-update-timings.mjs",
      "  node scripts/test-update-timings.mjs --config vitest.unit.config.ts --limit 128",
      "  node scripts/test-update-timings.mjs --report /tmp/vitest-report.json --out /tmp/timings.json",
    ].join("\n"),
  );
  process.exit(0);
}

function parseArgs(argv) {
  return parseFlagArgs(
    argv,
    {
      config: "vitest.unit.config.ts",
      limit: 256,
      reportPath: "",
      out: unitTimingManifestPath,
      defaultDurationMs: 250,
    },
    [
      stringFlag("--config", "config"),
      intFlag("--limit", "limit", { min: 1 }),
      stringFlag("--report", "reportPath"),
      stringFlag("--out", "out"),
      intFlag("--default-duration-ms", "defaultDurationMs", { min: 1 }),
    ],
  );
}

const opts = parseArgs(process.argv.slice(2));
const report = loadVitestReportFromArgs(opts, "openclaw-vitest-timings");
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
