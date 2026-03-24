import fs from "node:fs";
import path from "node:path";
import { intFlag, parseFlagArgs, stringFlag, stringListFlag } from "./lib/arg-utils.mjs";
import { parseMemoryTraceSummaryLines } from "./test-parallel-memory.mjs";
import { normalizeTrackedRepoPath, tryReadJsonFile, writeJsonFile } from "./test-report-utils.mjs";
import { unitMemoryHotspotManifestPath } from "./test-runner-manifest.mjs";
import { matchesHotspotSummaryLane } from "./test-update-memory-hotspots-utils.mjs";

function parseArgs(argv) {
  return parseFlagArgs(
    argv,
    {
      config: "vitest.unit.config.ts",
      out: unitMemoryHotspotManifestPath,
      lane: "unit-fast",
      lanePrefixes: [],
      logs: [],
      minDeltaKb: 256 * 1024,
      limit: 64,
    },
    [
      stringFlag("--config", "config"),
      stringFlag("--out", "out"),
      stringFlag("--lane", "lane"),
      stringListFlag("--lane-prefix", "lanePrefixes"),
      stringListFlag("--log", "logs"),
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

if (opts.logs.length === 0) {
  console.error("[test-update-memory-hotspots] pass at least one --log <path>.");
  process.exit(2);
}

const aggregated = new Map();
const existing = tryReadJsonFile(opts.out, null);
if (existing) {
  for (const [file, value] of Object.entries(existing.files ?? {})) {
    mergeHotspotEntry(aggregated, file, value);
  }
}
for (const logPath of opts.logs) {
  const text = fs.readFileSync(logPath, "utf8");
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
        sources: [`${path.basename(logPath, path.extname(logPath))}:${summary.lane}`],
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
