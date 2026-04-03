import { intFlag, parseFlagArgs, stringFlag, stringListFlag } from "./lib/arg-utils.mjs";
import { parseMemoryTraceSummaryLines } from "./test-parallel-memory.mjs";
import { normalizeTrackedRepoPath, tryReadJsonFile, writeJsonFile } from "./test-report-utils.mjs";
import { unitMemoryHotspotManifestPath } from "./test-runner-manifest.mjs";
import { loadHotspotInputTexts } from "./test-update-memory-hotspots-sources.mjs";
import { matchesHotspotSummaryLane } from "./test-update-memory-hotspots-utils.mjs";

if (process.argv.slice(2).includes("--help")) {
  console.log(
    [
      "Usage: node scripts/test-update-memory-hotspots.mjs [options]",
      "",
      "Generate or refresh the unit memory-hotspot manifest from test-parallel memory logs.",
      "",
      "Options:",
      "  --config <path>            Vitest config label stored in the output manifest",
      "  --out <path>               Output manifest path (default: test/fixtures/test-memory-hotspots.unit.json)",
      "  --lane <name>              Primary lane name to match (default: unit-fast)",
      "  --lane-prefix <prefix>     Additional lane prefixes to include (repeatable)",
      "  --log <path>               Memory trace log to ingest (repeatable, required)",
      "  --gh-job <id>              GitHub Actions job id to ingest via gh (repeatable)",
      "  --gh-run <id>              GitHub Actions run id to ingest via gh (repeatable)",
      "  --gh-run-job-match <text>  Filter gh-run jobs by name substring (repeatable)",
      "  --min-delta-kb <kb>        Minimum RSS delta to retain (default: 262144)",
      "  --limit <count>            Max hotspot entries to retain (default: 64)",
      "  --help                     Show this help text",
      "",
      "Examples:",
      "  node scripts/test-update-memory-hotspots.mjs --log /tmp/unit-fast.log",
      "  node scripts/test-update-memory-hotspots.mjs --log a.log --log b.log --lane-prefix unit-fast-batch-",
      "  node scripts/test-update-memory-hotspots.mjs --gh-job 69804189668 --gh-job 69804189672",
      "  node scripts/test-update-memory-hotspots.mjs --gh-run 23933168654 --gh-run-job-match extensions",
    ].join("\n"),
  );
  process.exit(0);
}

function parseArgs(argv) {
  return parseFlagArgs(
    argv,
    {
      config: "vitest.unit.config.ts",
      out: unitMemoryHotspotManifestPath,
      lane: "unit-fast",
      lanePrefixes: [],
      logs: [],
      ghJobs: [],
      ghRuns: [],
      ghRunJobMatches: [],
      minDeltaKb: 256 * 1024,
      limit: 64,
    },
    [
      stringFlag("--config", "config"),
      stringFlag("--out", "out"),
      stringFlag("--lane", "lane"),
      stringListFlag("--lane-prefix", "lanePrefixes"),
      stringListFlag("--log", "logs"),
      stringListFlag("--gh-job", "ghJobs"),
      stringListFlag("--gh-run", "ghRuns"),
      stringListFlag("--gh-run-job-match", "ghRunJobMatches"),
      intFlag("--min-delta-kb", "minDeltaKb", { min: 1 }),
      intFlag("--limit", "limit", { min: 1 }),
    ],
  );
}

function mergeHotspotEntry(aggregated, file, value) {
  if (!(Number.isFinite(value?.deltaKb) && value.deltaKb > 0)) {
    return;
  }
  const normalizedFile = normalizeTrackedRepoPath(file);
  const normalizeSourceLabel = (source) => {
    const separator = source.lastIndexOf(":");
    if (separator === -1) {
      return source.endsWith(".log") ? source.slice(0, -4) : source;
    }
    const name = source.slice(0, separator);
    const lane = source.slice(separator + 1);
    return `${name.endsWith(".log") ? name.slice(0, -4) : name}:${lane}`;
  };
  const nextSources = Array.isArray(value?.sources)
    ? value.sources
        .filter((source) => typeof source === "string" && source.length > 0)
        .map(normalizeSourceLabel)
    : [];
  const previous = aggregated.get(normalizedFile);
  if (!previous) {
    aggregated.set(normalizedFile, {
      deltaKb: Math.round(value.deltaKb),
      sources: [...new Set(nextSources)],
    });
    return;
  }
  previous.deltaKb = Math.max(previous.deltaKb, Math.round(value.deltaKb));
  for (const source of nextSources) {
    if (!previous.sources.includes(source)) {
      previous.sources.push(source);
    }
  }
}

const opts = parseArgs(process.argv.slice(2));

if (opts.logs.length === 0 && opts.ghJobs.length === 0 && opts.ghRuns.length === 0) {
  console.error(
    "[test-update-memory-hotspots] pass at least one --log <path>, --gh-job <id>, or --gh-run <id>.",
  );
  process.exit(2);
}

const aggregated = new Map();
const existing = tryReadJsonFile(opts.out, null);
if (existing) {
  for (const [file, value] of Object.entries(existing.files ?? {})) {
    mergeHotspotEntry(aggregated, file, value);
  }
}
for (const input of loadHotspotInputTexts({
  logPaths: opts.logs,
  ghJobs: opts.ghJobs,
  ghRuns: opts.ghRuns,
  ghRunJobMatches: opts.ghRunJobMatches,
})) {
  const text = input.text;
  const summaries = parseMemoryTraceSummaryLines(text).filter((summary) =>
    matchesHotspotSummaryLane(summary.lane, opts.lane, opts.lanePrefixes),
  );
  for (const summary of summaries) {
    for (const record of summary.top) {
      if (record.deltaKb < opts.minDeltaKb) {
        continue;
      }
      mergeHotspotEntry(aggregated, record.file, {
        deltaKb: record.deltaKb,
        sources: [`${input.sourceName}:${summary.lane}`],
      });
    }
  }
}

const files = Object.fromEntries(
  [...aggregated.entries()]
    .toSorted((left, right) => right[1].deltaKb - left[1].deltaKb)
    .slice(0, opts.limit)
    .map(([file, value]) => [
      file,
      {
        deltaKb: value.deltaKb,
        sources: value.sources.toSorted(),
      },
    ]),
);

const output = {
  config: opts.config,
  generatedAt: new Date().toISOString(),
  defaultMinDeltaKb: opts.minDeltaKb,
  lane:
    opts.lanePrefixes.length === 0
      ? opts.lane
      : [opts.lane, ...opts.lanePrefixes.map((prefix) => String(prefix).concat("*"))].join(", "),
  files,
};

writeJsonFile(opts.out, output);
console.log(
  `[test-update-memory-hotspots] wrote ${String(Object.keys(files).length)} hotspots to ${opts.out}`,
);
