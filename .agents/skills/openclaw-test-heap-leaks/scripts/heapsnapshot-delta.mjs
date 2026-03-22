#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function printUsage() {
  console.error(
    "Usage: node heapsnapshot-delta.mjs <before.heapsnapshot> <after.heapsnapshot> [--top N] [--min-kb N]",
  );
  console.error(
    "   or: node heapsnapshot-delta.mjs --lane-dir <dir> [--pid PID] [--top N] [--min-kb N]",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    top: 30,
    minKb: 64,
    laneDir: null,
    pid: null,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--top") {
      options.top = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--min-kb") {
      options.minKb = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--lane-dir") {
      options.laneDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--pid") {
      options.pid = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    options.files.push(arg);
  }

  if (!Number.isFinite(options.top) || options.top <= 0) {
    fail("--top must be a positive integer");
  }
  if (!Number.isFinite(options.minKb) || options.minKb < 0) {
    fail("--min-kb must be a non-negative integer");
  }
  if (options.pid !== null && (!Number.isInteger(options.pid) || options.pid <= 0)) {
    fail("--pid must be a positive integer");
  }

  return options;
}

function parseHeapFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(
    /^Heap\.(?<stamp>\d{8}\.\d{6})\.(?<pid>\d+)\.0\.(?<seq>\d+)\.heapsnapshot$/u,
  );
  if (!match?.groups) {
    return null;
  }
  return {
    filePath,
    pid: Number.parseInt(match.groups.pid, 10),
    stamp: match.groups.stamp,
    sequence: Number.parseInt(match.groups.seq, 10),
  };
}

function resolvePair(options) {
  if (options.laneDir) {
    const entries = fs
      .readdirSync(options.laneDir)
      .map((name) => parseHeapFilename(path.join(options.laneDir, name)))
      .filter((entry) => entry !== null)
      .filter((entry) => options.pid === null || entry.pid === options.pid)
      .toSorted((left, right) => {
        if (left.pid !== right.pid) {
          return left.pid - right.pid;
        }
        if (left.stamp !== right.stamp) {
          return left.stamp.localeCompare(right.stamp);
        }
        return left.sequence - right.sequence;
      });

    if (entries.length === 0) {
      fail(`No matching heap snapshots found in ${options.laneDir}`);
    }

    const groups = new Map();
    for (const entry of entries) {
      const group = groups.get(entry.pid) ?? [];
      group.push(entry);
      groups.set(entry.pid, group);
    }

    const candidates = Array.from(groups.values())
      .map((group) => ({
        pid: group[0].pid,
        before: group[0],
        after: group.at(-1),
        count: group.length,
      }))
      .filter((entry) => entry.count >= 2);

    if (candidates.length === 0) {
      fail(`Need at least two snapshots for one PID in ${options.laneDir}`);
    }

    const chosen =
      options.pid !== null
        ? (candidates.find((entry) => entry.pid === options.pid) ?? null)
        : candidates.toSorted((left, right) => right.count - left.count || left.pid - right.pid)[0];

    if (!chosen) {
      fail(`No PID with at least two snapshots matched in ${options.laneDir}`);
    }

    return {
      before: chosen.before.filePath,
      after: chosen.after.filePath,
      pid: chosen.pid,
      snapshotCount: chosen.count,
    };
  }

  if (options.files.length !== 2) {
    printUsage();
    process.exit(1);
  }

  return {
    before: options.files[0],
    after: options.files[1],
    pid: null,
    snapshotCount: 2,
  };
}

function loadSummary(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const meta = data.snapshot?.meta;
  if (!meta) {
    fail(`Invalid heap snapshot: ${filePath}`);
  }

  const nodeFieldCount = meta.node_fields.length;
  const typeNames = meta.node_types[0];
  const strings = data.strings;
  const typeIndex = meta.node_fields.indexOf("type");
  const nameIndex = meta.node_fields.indexOf("name");
  const selfSizeIndex = meta.node_fields.indexOf("self_size");

  const summary = new Map();
  for (let offset = 0; offset < data.nodes.length; offset += nodeFieldCount) {
    const type = typeNames[data.nodes[offset + typeIndex]];
    const name = strings[data.nodes[offset + nameIndex]];
    const selfSize = data.nodes[offset + selfSizeIndex];
    const key = `${type}\t${name}`;
    const current = summary.get(key) ?? {
      type,
      name,
      selfSize: 0,
      count: 0,
    };
    current.selfSize += selfSize;
    current.count += 1;
    summary.set(key, current);
  }
  return {
    nodeCount: data.snapshot.node_count,
    summary,
  };
}

function formatBytes(bytes) {
  if (Math.abs(bytes) >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  }
  if (Math.abs(bytes) >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function formatDelta(bytes) {
  return `${bytes >= 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pair = resolvePair(options);
  const before = loadSummary(pair.before);
  const after = loadSummary(pair.after);
  const minBytes = options.minKb * 1024;

  const rows = [];
  for (const [key, next] of after.summary) {
    const previous = before.summary.get(key) ?? { selfSize: 0, count: 0 };
    const sizeDelta = next.selfSize - previous.selfSize;
    const countDelta = next.count - previous.count;
    if (sizeDelta < minBytes) {
      continue;
    }
    rows.push({
      type: next.type,
      name: next.name,
      sizeDelta,
      countDelta,
      afterSize: next.selfSize,
      afterCount: next.count,
    });
  }

  rows.sort(
    (left, right) => right.sizeDelta - left.sizeDelta || right.countDelta - left.countDelta,
  );

  console.log(`before: ${pair.before}`);
  console.log(`after:  ${pair.after}`);
  if (pair.pid !== null) {
    console.log(`pid:    ${pair.pid} (${pair.snapshotCount} snapshots found)`);
  }
  console.log(
    `nodes:   ${before.nodeCount} -> ${after.nodeCount} (${after.nodeCount - before.nodeCount >= 0 ? "+" : ""}${after.nodeCount - before.nodeCount})`,
  );
  console.log(`filter:  top=${options.top} min=${options.minKb} KiB`);
  console.log("");

  if (rows.length === 0) {
    console.log("No entries exceeded the minimum delta.");
    return;
  }

  for (const row of rows.slice(0, options.top)) {
    console.log(
      [
        formatDelta(row.sizeDelta).padStart(11),
        `count ${row.countDelta >= 0 ? "+" : ""}${row.countDelta}`.padStart(10),
        row.type.padEnd(16),
        truncate(row.name || "(empty)", 96),
      ].join("  "),
    );
  }
}

main();
