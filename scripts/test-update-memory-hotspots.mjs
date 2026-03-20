import fs from "node:fs";
import path from "node:path";
import { parseMemoryTraceSummaryLines } from "./test-parallel-memory.mjs";
import { unitMemoryHotspotManifestPath } from "./test-runner-manifest.mjs";

function parseArgs(argv) {
  const args = {
    config: "vitest.unit.config.ts",
    out: unitMemoryHotspotManifestPath,
    lane: "unit-fast",
    logs: [],
    minDeltaKb: 256 * 1024,
    limit: 64,
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
    if (arg === "--lane") {
      args.lane = argv[i + 1] ?? args.lane;
      i += 1;
      continue;
    }
    if (arg === "--log") {
      const logPath = argv[i + 1];
      if (typeof logPath === "string" && logPath.length > 0) {
        args.logs.push(logPath);
      }
      i += 1;
      continue;
    }
    if (arg === "--min-delta-kb") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.minDeltaKb = parsed;
      }
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
  }
  return args;
}

const normalizeRepoPath = (value) => value.split(path.sep).join("/");
const repoRoot = path.resolve(process.cwd());
const normalizeTrackedRepoPath = (value) => {
  const normalizedValue = typeof value === "string" ? value : String(value ?? "");
  const repoRelative = path.isAbsolute(normalizedValue)
    ? path.relative(repoRoot, path.resolve(normalizedValue))
    : normalizedValue;
  if (path.isAbsolute(repoRelative) || repoRelative.startsWith("..") || repoRelative === "") {
    return normalizeRepoPath(normalizedValue);
  }
  return normalizeRepoPath(repoRelative);
};

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
try {
  const existing = JSON.parse(fs.readFileSync(opts.out, "utf8"));
  for (const [file, value] of Object.entries(existing.files ?? {})) {
    mergeHotspotEntry(aggregated, file, value);
  }
} catch {
  // Start from scratch when the output file does not exist yet.
}
for (const logPath of opts.logs) {
  const text = fs.readFileSync(logPath, "utf8");
  const summaries = parseMemoryTraceSummaryLines(text).filter(
    (summary) => summary.lane === opts.lane,
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
  lane: opts.lane,
  files,
};

fs.writeFileSync(opts.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `[test-update-memory-hotspots] wrote ${String(Object.keys(files).length)} hotspots to ${opts.out}`,
);
