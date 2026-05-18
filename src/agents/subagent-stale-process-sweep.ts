import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SUBAGENT_STALE_PROCESS_RISK = "STALE_PROCESS_RISK" as const;

export type SubagentObservedProcess = {
  pid: number;
  ppid?: number;
  command?: string;
  cwd?: string;
  startedAtMs?: number;
  childRunId?: string;
  childSessionKey?: string;
};

export type SubagentStaleProcessSweepResult = {
  status: "clean" | typeof SUBAGENT_STALE_PROCESS_RISK;
  noRunningProcesses: boolean;
  relevantProcessCount: number;
  reasons: string[];
  processes: Array<{
    pid: number;
    ppid?: number;
    command?: string;
    cwd?: string;
  }>;
};

const DEFAULT_RELEVANT_COMMAND_RE =
  /\b(?:vitest|jest|mocha|ava|tap|node\s+.*(?:run-vitest|tsx|ts-node)|pnpm\s+(?:test|vitest)|npm\s+(?:test|run\s+test)|python\s+-m\s+unittest|pytest)\b/i;

function normalizeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function commandMatches(command: string | undefined, patterns: RegExp[]): boolean {
  const normalized = normalizeToken(command);
  return Boolean(normalized && patterns.some((pattern) => pattern.test(normalized)));
}

function resolveWorkspaceRoot(workspaceDir: string | undefined): string | undefined {
  const normalized = normalizeToken(workspaceDir);
  if (!normalized) {
    return undefined;
  }
  return path.resolve(normalized);
}

function isPathEqualOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function processMatchesWorkspace(
  process: SubagentObservedProcess,
  workspaceRoot: string | undefined,
): boolean {
  if (!workspaceRoot) {
    return true;
  }
  const cwd = normalizeToken(process.cwd);
  if (cwd && isPathEqualOrInside(path.resolve(cwd), workspaceRoot)) {
    return true;
  }
  return Boolean(process.command?.includes(workspaceRoot));
}

function processMatchesIdentity(
  process: SubagentObservedProcess,
  params: {
    childRunId?: string;
    childSessionKey?: string;
  },
): boolean {
  const childRunId = normalizeToken(params.childRunId);
  const childSessionKey = normalizeToken(params.childSessionKey);
  return Boolean(
    (childRunId && process.childRunId === childRunId) ||
    (childSessionKey && process.childSessionKey === childSessionKey),
  );
}

export function detectSubagentStaleProcessRisk(params: {
  processes: SubagentObservedProcess[];
  childRunId?: string;
  childSessionKey?: string;
  workspaceDir?: string;
  relevantCommandPatterns?: RegExp[];
}): SubagentStaleProcessSweepResult {
  const patterns = params.relevantCommandPatterns?.length
    ? params.relevantCommandPatterns
    : [DEFAULT_RELEVANT_COMMAND_RE];
  const workspaceRoot = resolveWorkspaceRoot(params.workspaceDir);
  const relevant = params.processes.filter(
    (process) =>
      processMatchesIdentity(process, params) ||
      (commandMatches(process.command, patterns) &&
        processMatchesWorkspace(process, workspaceRoot)),
  );
  if (relevant.length === 0) {
    return {
      status: "clean",
      noRunningProcesses: true,
      relevantProcessCount: 0,
      reasons: ["NO_RELEVANT_CHILD_OR_TEST_PROCESSES"],
      processes: [],
    };
  }
  return {
    status: SUBAGENT_STALE_PROCESS_RISK,
    noRunningProcesses: false,
    relevantProcessCount: relevant.length,
    reasons: ["RELEVANT_CHILD_OR_TEST_PROCESS_STILL_RUNNING"],
    processes: relevant.map((process) => ({
      pid: process.pid,
      ...(typeof process.ppid === "number" ? { ppid: process.ppid } : {}),
      ...(process.command ? { command: process.command } : {}),
      ...(process.cwd ? { cwd: process.cwd } : {}),
    })),
  };
}

function readProcessCwd(pid: number): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

function parsePsOutput(output: string): SubagentObservedProcess[] {
  const currentPid = process.pid;
  const parentPid = process.ppid;
  const processes: SubagentObservedProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1] ?? "", 10);
    const ppid = Number.parseInt(match[2] ?? "", 10);
    const command = normalizeToken(match[3]);
    if (!Number.isFinite(pid) || pid === currentPid || pid === parentPid) {
      continue;
    }
    const cwd = readProcessCwd(pid);
    processes.push({
      pid,
      ...(Number.isFinite(ppid) ? { ppid } : {}),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }
  return processes;
}

export function collectSubagentStaleProcessSweep(params: {
  childRunId?: string;
  childSessionKey?: string;
  workspaceDir?: string;
  relevantCommandPatterns?: RegExp[];
}): SubagentStaleProcessSweepResult {
  try {
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return detectSubagentStaleProcessRisk({
      processes: parsePsOutput(output),
      childRunId: params.childRunId,
      childSessionKey: params.childSessionKey,
      workspaceDir: params.workspaceDir,
      relevantCommandPatterns: params.relevantCommandPatterns,
    });
  } catch {
    return {
      status: "clean",
      noRunningProcesses: true,
      relevantProcessCount: 0,
      reasons: ["STALE_PROCESS_SWEEP_UNAVAILABLE"],
      processes: [],
    };
  }
}

export function shouldRunSubagentStaleProcessSweep(params: {
  task?: string;
  outcomeStatus?: string;
}): boolean {
  const text = `${params.task ?? ""} ${params.outcomeStatus ?? ""}`;
  return /\b(?:test|tests|vitest|jest|mocha|pytest|unittest|process|shell|exec|timeout|timed?out|gate|checker)\b/i.test(
    text,
  );
}
