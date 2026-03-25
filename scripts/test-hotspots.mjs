import {
  formatMs,
  loadVitestReportFromArgs,
  parseVitestReportArgs,
} from "./lib/vitest-report-cli-utils.mjs";
import { collectVitestFileDurations } from "./test-report-utils.mjs";

const opts = parseVitestReportArgs(process.argv.slice(2), {
  config: "vitest.unit.config.ts",
  limit: 20,
});
const report = loadVitestReportFromArgs(opts, "openclaw-vitest-hotspots");
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
