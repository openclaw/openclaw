import { spawnSync } from "node:child_process";

const ESCAPE = String.fromCodePoint(27);
const BELL = String.fromCodePoint(7);
const ANSI_ESCAPE_PATTERN = new RegExp(
  // Strip CSI/OSC-style control sequences from Vitest output before parsing file lines.
  `${ESCAPE}(?:\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_])`,
  "g",
);

const COMPLETED_TEST_FILE_LINE_PATTERN =
  /(?<file>(?:src|extensions|test|ui)\/\S+?\.(?:live\.test|e2e\.test|test)\.ts)\s+\(.*\)\s+(?<duration>\d+(?:\.\d+)?)(?<unit>ms|s)\s*$/;

const PS_COLUMNS = ["pid=", "ppid=", "rss="];

function parseDurationMs(rawValue, unit) {
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return unit === "s" ? Math.round(parsed * 1000) : Math.round(parsed);
}

function stripAnsi(text) {
  return text.replaceAll(ANSI_ESCAPE_PATTERN, "");
}

export function parseCompletedTestFileLines(text) {
  return stripAnsi(text)
    .split(/\r?\n/u)
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

export function sampleProcessTreeRssKb(rootPid) {
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
  const rssByPid = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidRaw, parentRaw, rssRaw] = trimmed.split(/\s+/u);
    const pid = Number.parseInt(pidRaw ?? "", 10);
    const parentPid = Number.parseInt(parentRaw ?? "", 10);
    const rssKb = Number.parseInt(rssRaw ?? "", 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || !Number.isInteger(rssKb)) {
      continue;
    }
    const siblings = childPidsByParent.get(parentPid) ?? [];
    siblings.push(pid);
    childPidsByParent.set(parentPid, siblings);
    rssByPid.set(pid, rssKb);
  }

  if (!rssByPid.has(rootPid)) {
    return null;
  }

  let rssKb = 0;
  let processCount = 0;
  const queue = [rootPid];
  const visited = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) {
      continue;
    }
    visited.add(pid);
    const currentRssKb = rssByPid.get(pid);
    if (currentRssKb !== undefined) {
      rssKb += currentRssKb;
      processCount += 1;
    }
    for (const childPid of childPidsByParent.get(pid) ?? []) {
      if (!visited.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  return { rssKb, processCount };
}
