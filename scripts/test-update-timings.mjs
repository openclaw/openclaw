import { intFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { loadVitestReportFromArgs, parseVitestReportArgs } from "./lib/vitest-report-cli-utils.mjs";
import {
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
  writeJsonFile,
} from "./test-report-utils.mjs";
import { unitTimingManifestPath } from "./test-runner-manifest.mjs";

function parseArgs(argv) {
  return parseFlagArgs(
    argv,
    {
      ...parseVitestReportArgs(argv, {
        config: "vitest.unit.config.ts",
        limit: 256,
        reportPath: "",
      }),
      out: unitTimingManifestPath,
      defaultDurationMs: 250,
    },
    [stringFlag("--out", "out"), intFlag("--default-duration-ms", "defaultDurationMs", { min: 1 })],
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
