import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ESCAPE = String.fromCodePoint(27);
const BELL = String.fromCodePoint(7);
const ANSI_ESCAPE_PATTERN = new RegExp(
  // Strip CSI/OSC-style control sequences from Vitest output before parsing file lines.
  `${ESCAPE}(?:\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])`,
  "g",
);
const GITHUB_CLI_LOG_PREFIX_PATTERN =
  /^[^\t\r\n]+\t[^\t\r\n]+\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/u;
const GITHUB_ACTIONS_LOG_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/u;

const COMPLETED_TEST_FILE_LINE_PATTERN =
  /(?<file>(?:src|extensions|test|ui)\/\S+?\.(?:live\.test|e2e\.test|test)\.ts)\s+\(.*\)\s+(?<duration>\d+(?:\.\d+)?)(?<unit>ms|s)\s*$/;
const MEMORY_TRACE_SUMMARY_PATTERN =
  /^\[test-parallel\]\[mem\] summary (?<lane>\S+) files=(?<files>\d+) peak=(?<peak>[0-9]+(?:\.[0-9]+)?(?:GiB|MiB|KiB)) totalDelta=(?<totalDelta>[+-]?[0-9]+(?:\.[0-9]+)?(?:GiB|MiB|KiB)) peakAt=(?<peakAt>\S+) top=(?<top>.*)$/u;
const MEMORY_TRACE_TOP_ENTRY_PATTERN =
  /^(?<file>(?:src|extensions|test|ui)\/\S+?\.(?:live\.test|e2e\.test|test)\.ts):(?<delta>[+-]?[0-9]+(?:\.[0-9]+)?(?:GiB|MiB|KiB))$/u;

const PS_COLUMNS = ["pid=", "ppid=", "rss=", "comm="];

function parseDurationMs(rawValue, unit) {
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return unit === "s" ? Math.round(parsed * 1000) : Math.round(parsed);
}

export function parseMemoryValueKb(rawValue) {
  const match = rawValue.match(/^(?<sign>[+-]?)(?<value>\d+(?:\.\d+)?)(?<unit>GiB|MiB|KiB)$/u);
  if (!match?.groups) {
    return null;
  }
  const value = Number.parseFloat(match.groups.value);
  if (!Number.isFinite(value)) {
    return null;
  }
  const multiplier =
    match.groups.unit === "GiB" ? 1024 ** 2 : match.groups.unit === "MiB" ? 1024 : 1;
  const signed = Math.round(value * multiplier);
  return match.groups.sign === "-" ? -signed : signed;
}

function stripAnsi(text) {
  return text.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

function normalizeLogLine(line) {
  return line
    .replace(GITHUB_CLI_LOG_PREFIX_PATTERN, "")
    .replace(GITHUB_ACTIONS_LOG_PREFIX_PATTERN, "");
}

export function parseCompletedTestFileLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/u)
    .map((line) => normalizeLogLine(line))
    .map((line) => {
      const match = line.match(COMPLETED_TEST_FILE_LINE_PATTERN);
      if (!match?.groups) {
        return null;
      }
      return {
        file: match.groups.file,
        durationMs: parseDurationMs(match.groups.duration, match.groups.unit),
      };
    })
    .filter((entry) => entry !== null);
}

export function parseMemoryTraceSummaryLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/u)
    .map((line) => normalizeLogLine(line))
    .map((line) => {
      const match = line.match(MEMORY_TRACE_SUMMARY_PATTERN);
      if (!match?.groups) {
        return null;
      }
      const peakRssKb = parseMemoryValueKb(match.groups.peak);
      const totalDeltaKb = parseMemoryValueKb(match.groups.totalDelta);
      const fileCount = Number.parseInt(match.groups.files, 10);
      if (!Number.isInteger(fileCount) || peakRssKb === null || totalDeltaKb === null) {
        return null;
      }
      const top =
        match.groups.top === "none"
          ? []
          : match.groups.top
              .split(/,\s+/u)
              .map((entry) => {
                const topMatch = entry.match(MEMORY_TRACE_TOP_ENTRY_PATTERN);
                if (!topMatch?.groups) {
                  return null;
                }
                const deltaKb = parseMemoryValueKb(topMatch.groups.delta);
                if (deltaKb === null) {
                  return null;
                }
                return {
                  file: topMatch.groups.file,
                  deltaKb,
                };
              })
              .filter((entry) => entry !== null);
      return {
        lane: match.groups.lane,
        files: fileCount,
        peakRssKb,
        totalDeltaKb,
        peakAt: match.groups.peakAt,
        top,
      };
    })
    .filter((entry) => entry !== null);
}

export function getProcessTreeRecords(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || process.platform === "win32") {
    return null;
  }

  const result = spawnSync("ps", ["-axo", PS_COLUMNS.join(",")], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error) {
    return null;
  }

  const childPidsByParent = new Map();
  const recordsByPid = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidRaw, parentRaw, rssRaw, commandRaw] = trimmed.split(/\s+/u, 4);
    const pid = Number.parseInt(pidRaw ?? "", 10);
    const parentPid = Number.parseInt(parentRaw ?? "", 10);
    const rssKb = Number.parseInt(rssRaw ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isInteger(rssKb)) {
      continue;
    }
    const siblings = childPidsByParent.get(parentPid) ?? [];
    siblings.push(pid);
    childPidsByParent.set(parentPid, siblings);
    recordsByPid.set(pid, {
      pid,
      parentPid,
      rssKb,
      command: commandRaw ?? "",
    });
  }

  if (!recordsByPid.has(rootPid)) {
    return null;
  }

  const queue = [rootPid];
  const visited = new Set();
  const records = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    const record = recordsByPid.get(pid);
    if (record) {
      records.push(record);
    }
    for (const childPid of childPidsByParent.get(pid) ?? []) {
      if (!visited.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  return records;
}

export function sampleProcessTreeRssKb(rootPid) {
  const records = getProcessTreeRecords(rootPid);
  if (!records) {
    return null;
  }

  let rssKb = 0;
  let processCount = 0;
  for (const record of records) {
    rssKb += record.rssKb;
    processCount += 1;
  }

  return { rssKb, processCount };
}

const REPORT_FILE_PATTERN =
  /^report\.(?<date>\d+)\.(?<time>\d+)\.(?<pid>\d+)\.0\.(?<sequence>\d+)\.json$/u;

function readDiagnosticReport(reportPath) {
  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    const parsed = JSON.parse(raw);
    const rssBytes = parsed?.resourceUsage?.rss;
    const usedHeapBytes = parsed?.javascriptHeap?.usedMemory;
    const externalBytes = parsed?.javascriptHeap?.externalMemory;
    if (
      !Number.isFinite(rssBytes) ||
      !Number.isFinite(usedHeapBytes) ||
      !Number.isFinite(externalBytes)
    ) {
      return null;
    }
    return {
      rssKb: Math.round(rssBytes / 1024),
      usedHeapKb: Math.round(usedHeapBytes / 1024),
      externalKb: Math.round(externalBytes / 1024),
    };
  } catch {
    return null;
  }
}

export function summarizeDiagnosticReports(reportDir) {
  if (typeof reportDir !== "string" || reportDir.trim() === "") {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(reportDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const reportsByPid = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(REPORT_FILE_PATTERN);
    if (!match?.groups) {
      continue;
    }
    const pid = Number.parseInt(match.groups.pid, 10);
    const sequence = Number.parseInt(match.groups.sequence, 10);
    if (!Number.isInteger(pid) || !Number.isInteger(sequence)) {
      continue;
    }
    const reportPath = path.join(reportDir, entry.name);
    const report = readDiagnosticReport(reportPath);
    if (!report) {
      continue;
    }
    const bucket = reportsByPid.get(pid) ?? [];
    bucket.push({ pid, sequence, ...report });
    reportsByPid.set(pid, bucket);
  }

  return [...reportsByPid.entries()]
    .map(([pid, reports]) => {
      const ordered = reports.toSorted((left, right) => left.sequence - right.sequence);
      const first = ordered[0];
      const last = ordered.at(-1);
      if (!first || !last) {
        return null;
      }
      return {
        pid,
        first,
        last,
        rssDeltaKb: last.rssKb - first.rssKb,
        usedHeapDeltaKb: last.usedHeapKb - first.usedHeapKb,
        externalDeltaKb: last.externalKb - first.externalKb,
      };
    })
    .filter((entry) => entry !== null)
    .toSorted((left, right) => right.rssDeltaKb - left.rssDeltaKb);
}
