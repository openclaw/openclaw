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

const opts = parseArgs(process.argv.slice(2));

if (opts.logs.length === 0) {
  console.error("[test-update-memory-hotspots] pass at least one --log <path>.");
  process.exit(2);
}

const aggregated = new Map();
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
      const nextSource = `${path.basename(logPath)}:${summary.lane}`;
      const previous = aggregated.get(record.file);
      if (!previous) {
        aggregated.set(record.file, {
          deltaKb: record.deltaKb,
          sources: [nextSource],
        });
        continue;
      }
      previous.deltaKb = Math.max(previous.deltaKb, record.deltaKb);
      if (!previous.sources.includes(nextSource)) {
        previous.sources.push(nextSource);
      }
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
