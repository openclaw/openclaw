import {
  collectVitestFileDurations,
  readJsonFile,
  runVitestJsonReport,
} from "./test-report-utils.mjs";

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
const reportPath = runVitestJsonReport({
  config: opts.config,
  reportPath: opts.reportPath,
  prefix: "openclaw-vitest-hotspots",
});
const report = readJsonFile(reportPath);
const fileResults = collectVitestFileDurations(report).toSorted(
  (a, b) => b.durationMs - a.durationMs,
);

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
