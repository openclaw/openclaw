// Decides whether a retained dist-artifact owner record can still have live writers.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CENSUS_TIMEOUT_MS = 5_000;
// ps reports whole seconds, and Linux derives start times from boot-relative ticks.
const START_TIME_TOLERANCE_MS = 2_000;
// Another host's processes cannot be observed. Builds never run this long.
const FOREIGN_OWNER_MAX_AGE_MS = 24 * 60 * 60_000;
const OWNER_TOKENS_ENV = "OPENCLAW_DIST_ARTIFACT_OWNERS";
const PROCESS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/u;

type ProcessRow = { pid: number; ppid: number; pgid: number; state: string; startMs: number };
type ProcessTable = Map<number, ProcessRow>;

export type DistArtifactOwnerRecord = {
  pid?: unknown;
  startedAt?: unknown;
  startIdentity?: unknown;
  pgid?: unknown;
  token?: unknown;
  host?: unknown;
};

export type DistArtifactOwnerAssessment =
  /** The recorded owner, or a process that can still write for it, is running. */
  | { kind: "held"; detail: string }
  /** No live writers remain; `warning` names what could not be observed. */
  | { kind: "clear"; warning?: string }
  /** A snapshot failed or the owner is unobservable, which never proves death. */
  | { kind: "unknown"; detail: string };

function runPs(args: string[]) {
  return spawnSync("ps", args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CENSUS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function parseRow(line: string): ProcessRow | undefined {
  const match = PROCESS_ROW.exec(line);
  if (!match) {
    return undefined;
  }
  const startMs = Date.parse(match[5]!.replace(/\s+/gu, " "));
  return Number.isNaN(startMs)
    ? undefined
    : {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4]!,
        startMs,
      };
}

const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";

/** Slim containers lack ps and BusyBox lacks lstart, so Linux reads /proc. Assumes USER_HZ 100. */
export function parseLinuxProcStat(
  pid: number,
  stat: string,
  bootMs: number,
): ProcessRow | undefined {
  // The command name can itself contain spaces and parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTicks = Number(fields[19]);
  return Number.isNaN(startTicks)
    ? undefined
    : {
        pid,
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        state: fields[0]!,
        startMs: bootMs + startTicks * 10,
      };
}

function readLinuxBootMs() {
  return Number(/^btime (\d+)$/mu.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]) * 1_000;
}

function readLinuxProcessTable(): ProcessTable | "failed" {
  const table: ProcessTable = new Map();
  try {
    const bootMs = readLinuxBootMs();
    for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
      const pid = Number(name);
      try {
        const row = parseLinuxProcStat(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"), bootMs);
        if (row) {
          table.set(pid, row);
        }
      } catch {
        // The process exited during the walk.
      }
    }
  } catch {
    return "failed";
  }
  return table.has(process.pid) ? table : "failed";
}

function readProcessTable(): ProcessTable | "unavailable" | "failed" {
  if (process.platform === "linux") {
    return readLinuxProcessTable();
  }
  const result = runPs(["-A", "-o", PROCESS_COLUMNS]);
  const spawnFailure = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // ps can be absent, or setuid and unexecutable inside a platform sandbox.
  if (spawnFailure === "ENOENT" || spawnFailure === "EPERM" || spawnFailure === "EACCES") {
    return "unavailable";
  }
  if (result.error || result.status !== 0) {
    return "failed";
  }
  const table: ProcessTable = new Map();
  for (const line of result.stdout.split("\n")) {
    const row = parseRow(line);
    if (row) {
      table.set(row.pid, row);
    }
  }
  // An unparseable format is a failed observation, not an empty process table.
  return table.has(process.pid) ? table : "failed";
}

function isRunning(row: ProcessRow | undefined): row is ProcessRow {
  return row !== undefined && !/^[ZX]/u.test(row.state);
}

function asPid(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 1 &&
    value <= 0x7fffffff
    ? value
    : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A PID names the recorded process only if that process could have made the record. */
function isSameProcess(
  row: ProcessRow | undefined,
  identityMs: number | undefined,
  recordedAtMs: number,
): boolean {
  if (!isRunning(row)) {
    return false;
  }
  return identityMs === undefined
    ? row.startMs <= recordedAtMs + START_TIME_TOLERANCE_MS
    : Math.abs(row.startMs - identityMs) <= START_TIME_TOLERANCE_MS;
}

function readAncestors(table: ProcessTable): Set<number> {
  const ancestors = new Set([process.pid]);
  for (
    let row = table.get(process.pid);
    row && row.ppid > 1 && !ancestors.has(row.ppid);
    row = table.get(row.ppid)
  ) {
    ancestors.add(row.ppid);
  }
  return ancestors;
}

function readCommands(pids: number[], withEnvironment: boolean): Map<number, string> {
  const commands = new Map<number, string>();
  if (pids.length === 0) {
    return commands;
  }
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        commands.set(pid, fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
      } catch {
        // The process exited during the census.
      }
    }
    return commands;
  }
  const flags = withEnvironment ? ["-Eww"] : ["-ww"];
  const result = runPs([...flags, "-o", "pid=,command=", "-p", pids.join(",")]);
  for (const line of result.stdout?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s(.*)$/u.exec(line);
    if (match) {
      commands.set(Number(match[1]), match[2]!);
    }
  }
  return commands;
}

function carriesToken(pids: number[], token: string): Set<number> {
  if (process.platform === "linux") {
    return new Set(
      pids.filter((pid) => {
        try {
          return fs.readFileSync(`/proc/${pid}/environ`, "latin1").includes(token);
        } catch {
          return false;
        }
      }),
    );
  }
  // macOS hides the environment of platform binaries; the cwd rule below covers those.
  if (process.platform !== "darwin") {
    return new Set();
  }
  return new Set(
    [...readCommands(pids, true)].flatMap(([pid, text]) => (text.includes(token) ? [pid] : [])),
  );
}

function readWorkingDirectories(pids: number[]): Map<number, string> {
  const directories = new Map<number, string>();
  if (pids.length === 0) {
    return directories;
  }
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        directories.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // The process exited or is not visible; it holds no observable checkout cwd.
      }
    }
    return directories;
  }
  const result = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CENSUS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  let current: number | undefined;
  for (const line of result.stdout?.split("\n") ?? []) {
    if (line.startsWith("p")) {
      current = Number(line.slice(1));
    } else if (line.startsWith("n") && current !== undefined) {
      directories.set(current, line.slice(1));
    }
  }
  return directories;
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function liveClaims(claims: DistArtifactOwnerClaim[], table: ProcessTable) {
  return claims.flatMap((claim) =>
    isSameProcess(table.get(claim.pid), undefined, claim.claimedAtMs) ? [claim.pid] : [],
  );
}

export type DistArtifactOwnerClaim = { pid: number; claimedAtMs: number };

/**
 * Finds processes that can still write for a dead owner. Detached compilers lead
 * their own process group, so group membership alone cannot find them: new owners
 * export a token their descendants inherit, and records without one (or descendants
 * hiding their environment) fall back to orphans working inside this checkout.
 * Each process must also be younger than the record, so older services never match.
 * Accepted gap: an orphan under a Linux subreaper without a visible token.
 */
function findSurvivors(
  table: ProcessTable,
  record: DistArtifactOwnerRecord,
  recordedAtMs: number,
  checkoutRoot: string,
): number[] {
  const ancestors = readAncestors(table);
  const candidates = [...table.values()].filter(
    (row) =>
      isRunning(row) &&
      !ancestors.has(row.pid) &&
      row.pid > 1 &&
      row.startMs >= recordedAtMs - START_TIME_TOLERANCE_MS,
  );
  if (candidates.length === 0) {
    return [];
  }
  const group = asPid(record.pgid) ?? asPid(record.pid);
  const ownGroup = table.get(process.pid)?.pgid;
  const survivors = new Set(
    candidates.filter((row) => group !== ownGroup && row.pgid === group).map((row) => row.pid),
  );
  const token = typeof record.token === "string" && record.token ? record.token : undefined;
  if (token) {
    for (const pid of carriesToken(
      candidates.map((row) => row.pid),
      token,
    )) {
      survivors.add(pid);
    }
  }
  const orphans = candidates.filter((row) => row.ppid === 1).map((row) => row.pid);
  for (const [pid, directory] of readWorkingDirectories(orphans)) {
    if (isInside(checkoutRoot, directory)) {
      survivors.add(pid);
    }
  }
  // A Gateway outlives any one build and never writes this checkout's dist itself.
  // Match its subcommand or process title, not a directory that happens to share the word.
  const commands = readCommands([...survivors], false);
  return [...survivors]
    .filter((pid) => !/(?:^|\s)(?:openclaw-)?gateway(?:\s|$)/u.test(commands.get(pid) ?? ""))
    .toSorted((left, right) => left - right);
}

/** Platforms where ps cannot run keep only the checks kill(pid, 0) can answer. */
function assessWithoutProcessTable(
  owner: number | undefined,
  claims: DistArtifactOwnerClaim[],
): DistArtifactOwnerAssessment {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  if (owner !== undefined && alive(owner)) {
    return { kind: "held", detail: `PID ${owner} is still running` };
  }
  const running = claims.map((claim) => claim.pid).filter(alive);
  if (running.length > 0) {
    return { kind: "held", detail: `child PIDs ${running.join(", ")} are still running` };
  }
  return process.platform === "win32"
    ? // Managed Windows children run in a kill-on-close Job that ends with its owner.
      { kind: "clear" }
    : { kind: "clear", warning: "ps could not run, so detached descendants were not checked" };
}

/** Classify the record exposed by a retained lock. Failed observations never prove death. */
export function assessDistArtifactOwner(params: {
  record: DistArtifactOwnerRecord;
  recordMtimeMs: number;
  claims: DistArtifactOwnerClaim[];
  checkoutRoot: string;
  nowMs: number;
}): DistArtifactOwnerAssessment {
  const { record, recordMtimeMs, claims, checkoutRoot, nowMs } = params;
  const recordedAtMs = asTimestamp(record.startedAt) ?? recordMtimeMs;
  if (typeof record.host === "string" && record.host !== os.hostname()) {
    return nowMs - recordedAtMs < FOREIGN_OWNER_MAX_AGE_MS
      ? { kind: "unknown", detail: `the owner ran on another host (${record.host})` }
      : { kind: "clear", warning: `an abandoned record from host ${record.host} was replaced` };
  }
  const owner = asPid(record.pid);
  if (process.platform === "win32") {
    return assessWithoutProcessTable(owner, claims);
  }
  const table = readProcessTable();
  if (table === "unavailable") {
    return assessWithoutProcessTable(owner, claims);
  }
  if (table === "failed") {
    return { kind: "unknown", detail: "the process table could not be read" };
  }
  if (
    owner !== undefined &&
    isSameProcess(table.get(owner), asTimestamp(record.startIdentity), recordedAtMs)
  ) {
    return { kind: "held", detail: `PID ${owner} is still running` };
  }
  const running = liveClaims(claims, table);
  if (running.length > 0) {
    return { kind: "held", detail: `child PIDs ${running.join(", ")} are still running` };
  }
  const survivors = findSurvivors(table, record, recordedAtMs, checkoutRoot);
  return survivors.length > 0
    ? {
        kind: "held",
        detail: `the owner has exited, but descendant PIDs ${survivors.join(", ")} are still running`,
      }
    : { kind: "clear" };
}

let ownProcessFacts: { startIdentity?: string; pgid?: number } | undefined;

/** Facts a later process needs to tell this owner from a PID reuse and find its descendants. */
export function describeDistArtifactOwner(): {
  startIdentity?: string;
  pgid?: number;
  host: string;
} {
  if (!ownProcessFacts) {
    let row: ProcessRow | undefined;
    if (process.platform === "linux") {
      try {
        const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
        row = parseLinuxProcStat(process.pid, stat, readLinuxBootMs());
      } catch {
        // Falls back to the startedAt comparison below.
      }
    } else if (process.platform !== "win32") {
      const result = runPs(["-o", PROCESS_COLUMNS, "-p", String(process.pid)]);
      row = result.status === 0 ? parseRow(result.stdout.trim()) : undefined;
    }
    // A failed read falls back to the startedAt comparison, so it must not be cached as final.
    if (row) {
      ownProcessFacts = { startIdentity: new Date(row.startMs).toISOString(), pgid: row.pgid };
    }
  }
  return { ...ownProcessFacts, host: os.hostname() };
}

/** Descendants inherit this token, which marks them after they leave the owner's group. */
export function exportDistArtifactOwnerToken(token: string): () => void {
  const list = () => (process.env[OWNER_TOKENS_ENV] ?? "").split(",").filter(Boolean);
  process.env[OWNER_TOKENS_ENV] = [...list(), token].join(",");
  return () => {
    const remaining = list().filter((entry) => entry !== token);
    if (remaining.length > 0) {
      process.env[OWNER_TOKENS_ENV] = remaining.join(",");
    } else {
      delete process.env[OWNER_TOKENS_ENV];
    }
  };
}
