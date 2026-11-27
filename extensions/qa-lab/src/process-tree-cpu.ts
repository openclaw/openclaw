import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  asNonNegativeFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaWindowsPowerShellExePath } from "./windows-system-tools.js";

type ProcessTreeSnapshot = {
  childrenByParent: Map<number, number[]>;
  cpuByPid: Map<number, number>;
  rssByPid: Map<number, number>;
};

const PROCESS_TREE_SNAPSHOT_TIMEOUT_MS = 5_000;

function parsePsCpuTimeMs(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d+)-)?(\d+):(\d{2}(?:\.\d+)?)(?::(\d{2}(?:\.\d+)?))?$/u);
  if (!match) {
    return null;
  }
  const [, daysRaw, firstRaw, secondRaw, thirdRaw] = match;
  if (daysRaw !== undefined && thirdRaw === undefined) {
    return null;
  }
  const days = daysRaw === undefined ? 0 : Number(daysRaw);
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const third = thirdRaw === undefined ? 0 : Number(thirdRaw);
  const values = [days, first, second, third];
  if (values.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (thirdRaw !== undefined && !Number.isInteger(second)) {
    return null;
  }
  if (second >= 60 || (thirdRaw !== undefined && third >= 60)) {
    return null;
  }
  if (thirdRaw !== undefined) {
    return Math.round((days * 24 * 60 * 60 + first * 60 * 60 + second * 60 + third) * 1000);
  }
  return Math.round((first * 60 + second) * 1000);
}

function parsePsRssBytes(raw: string): number | null {
  const rssKiB = parseStrictFiniteNumber(raw);
  if (rssKiB === undefined || rssKiB < 0) {
    return null;
  }
  return Math.round(rssKiB * 1024);
}

function readLinuxProcessRssBytes(
  pid: number,
  onUnavailable?: (reason: string) => void,
): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:[ \t]+(\d+)[ \t]+kB[ \t]*$/mu);
    const rssKiB = parseStrictNonNegativeInteger(match?.[1]);
    if (rssKiB === undefined) {
      onUnavailable?.(`vmrss-unavailable pid=${pid}`);
      return null;
    }
    return rssKiB * 1024;
  } catch {
    onUnavailable?.(`proc-status-unreadable pid=${pid}`);
    return null;
  }
}

function parseWindowsProcessTreeSnapshot(raw: string): ProcessTreeSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : isPlainObject(parsed) ? [parsed] : [];
  if (entries.length === 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  const rssByPid = new Map<number, number>();
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const pid = parseStrictPositiveInteger(entry.ProcessId);
    const ppid = parseStrictNonNegativeInteger(entry.ParentProcessId);
    if (pid === undefined || ppid === undefined) {
      continue;
    }

    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);

    const kernelModeTime = asNonNegativeFiniteNumber(parseStrictFiniteNumber(entry.KernelModeTime));
    const userModeTime = asNonNegativeFiniteNumber(parseStrictFiniteNumber(entry.UserModeTime));
    if (kernelModeTime !== undefined && userModeTime !== undefined) {
      cpuByPid.set(pid, Math.round((kernelModeTime + userModeTime) / 10_000));
    }

    const rssBytes = asNonNegativeFiniteNumber(parseStrictFiniteNumber(entry.WorkingSetSize));
    if (rssBytes !== undefined) {
      rssByPid.set(pid, Math.round(rssBytes));
    }
  }

  return {
    childrenByParent,
    cpuByPid,
    rssByPid,
  };
}

function collectProcessTreeMetric(
  rootPid: number,
  childrenByParent: Map<number, number[]>,
  metricByPid: Map<number, number | null>,
  readRequiredMetric?: (pid: number) => number | null,
  onUnavailable?: (reason: string) => void,
): number | null {
  if (!metricByPid.has(rootPid)) {
    onUnavailable?.(`root-missing pid=${rootPid}`);
    return null;
  }

  let total = 0;
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const metric = readRequiredMetric ? readRequiredMetric(pid) : (metricByPid.get(pid) ?? 0);
    if (metric === null) {
      return null;
    }
    total += metric;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return total;
}

function readWindowsProcessTreeSnapshot(): ProcessTreeSnapshot | null {
  const result = spawnSync(
    resolveQaWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$ErrorActionPreference='Stop';",
        "Get-CimInstance Win32_Process |",
        "Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize |",
        "ConvertTo-Json -Compress",
      ].join(" "),
    ],
    {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return parseWindowsProcessTreeSnapshot(result.stdout);
}

function readProcessTreeMetric(params: {
  rootPid: number | null | undefined;
  posixColumn: "time=" | "rss=";
  parsePosixMetric: (raw: string) => number | null;
  windowsMetric: "cpuByPid" | "rssByPid";
  onUnavailable?: (reason: string) => void;
}): number | null {
  const { rootPid, onUnavailable } = params;
  if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0) {
    onUnavailable?.("invalid-root-pid");
    return null;
  }
  if (process.platform === "win32") {
    const snapshot = readWindowsProcessTreeSnapshot();
    if (!snapshot) {
      onUnavailable?.("windows-snapshot-unavailable");
      return null;
    }
    return collectProcessTreeMetric(
      rootPid,
      snapshot.childrenByParent,
      snapshot[params.windowsMetric],
      undefined,
      onUnavailable,
    );
  }
  const result = spawnSync("ps", ["-eo", `pid=,ppid=,${params.posixColumn}`], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TREE_SNAPSHOT_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    onUnavailable?.(`ps-failed status=${result.status}`);
    return null;
  }

  // ps can report zero after a leader exits while its threads still hold memory.
  // Keep that process in the tree and require an available VmRSS for every member.
  const readRequiredMetric =
    process.platform === "linux" && params.posixColumn === "rss="
      ? (pid: number) => readLinuxProcessRssBytes(pid, onUnavailable)
      : undefined;
  const childrenByParent = new Map<number, number[]>();
  const metricByPid = new Map<number, number | null>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(\S+))?$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, metricRaw] = match;
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const metric = readRequiredMetric ? null : params.parsePosixMetric(metricRaw ?? "");
    if (
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid) ||
      (!readRequiredMetric && metric === null)
    ) {
      continue;
    }
    metricByPid.set(pid, metric);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  return collectProcessTreeMetric(
    rootPid,
    childrenByParent,
    metricByPid,
    readRequiredMetric,
    onUnavailable,
  );
}

export function readProcessTreeCpuMs(rootPid: number | null | undefined): number | null {
  return readProcessTreeMetric({
    rootPid,
    posixColumn: "time=",
    parsePosixMetric: parsePsCpuTimeMs,
    windowsMetric: "cpuByPid",
  });
}

export function readProcessTreeRssBytes(
  rootPid: number | null | undefined,
  onUnavailable?: (reason: string) => void,
): number | null {
  return readProcessTreeMetric({
    rootPid,
    posixColumn: "rss=",
    parsePosixMetric: parsePsRssBytes,
    windowsMetric: "rssByPid",
    onUnavailable,
  });
}
