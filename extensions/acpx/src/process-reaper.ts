import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_FORCE_AFTER_MS = 750;

export type AcpxProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

export type AcpxProcessCleanupResult = {
  inspectedPids: number[];
  killedPids: number[];
};

export type AcpxProcessCleanupDeps = {
  listProcesses?: () => Promise<AcpxProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  forceAfterMs?: number;
};

type CleanupProcessTreeInput = AcpxProcessCleanupDeps & {
  rootPid: number;
  rootCommand?: string;
  processes?: AcpxProcessInfo[];
};

type ReapStaleOrphansInput = AcpxProcessCleanupDeps & {
  stateDir?: string;
};

type OwnershipOptions = {
  stateDir?: string;
};

function normalizeCommand(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/");
}

function hasPathSegment(command: string, segment: string): boolean {
  return command.includes(`/${segment}/`);
}

function isPositivePid(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value !== process.pid;
}

function normalizePathForCommandMatch(value: string | undefined): string {
  return normalizeCommand(value).replace(/\/+$/, "");
}

function isOpenClawAcpxWrapperCommand(command: string, options: OwnershipOptions = {}): boolean {
  if (!command.includes("codex-acp-wrapper.mjs")) {
    return false;
  }
  const stateDir = normalizePathForCommandMatch(options.stateDir);
  if (stateDir) {
    return command.includes(`${stateDir}/acpx/codex-acp-wrapper.mjs`);
  }
  return hasPathSegment(command, "acpx");
}

function isOpenClawPluginRuntimeDepsCommand(command: string): boolean {
  if (!hasPathSegment(command, "plugin-runtime-deps")) {
    return false;
  }
  return (
    command.includes("/node_modules/@zed-industries/codex-acp/") ||
    command.includes("/node_modules/@zed-industries/codex-acp-") ||
    command.includes("/node_modules/acpx/dist/")
  );
}

export function isOpenClawOwnedAcpxCommand(
  command: string | undefined,
  options: OwnershipOptions = {},
): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return false;
  }
  return (
    isOpenClawAcpxWrapperCommand(normalized, options) ||
    isOpenClawPluginRuntimeDepsCommand(normalized)
  );
}

export function isOpenClawOwnedAcpxProcess(
  processInfo: AcpxProcessInfo,
  options: OwnershipOptions = {},
): boolean {
  return isOpenClawOwnedAcpxCommand(processInfo.command, options);
}

export function parsePsProcessList(stdout: string): AcpxProcessInfo[] {
  const processes: AcpxProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3]?.trim() ?? "";
    if (!isPositivePid(pid) || !Number.isInteger(ppid) || ppid < 0 || !command) {
      continue;
    }
    processes.push({ pid, ppid, command });
  }
  return processes;
}

export async function listUnixProcesses(): Promise<AcpxProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePsProcessList(stdout);
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!isPositivePid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function collectProcessTree(rootPid: number, processes: AcpxProcessInfo[]): AcpxProcessInfo[] {
  const childrenByParent = new Map<number, AcpxProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.ppid, children);
  }

  const collected: AcpxProcessInfo[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
    }
    const current = processes.find((entry) => entry.pid === pid);
    if (current) {
      collected.push(current);
    }
  };
  visit(rootPid);
  return collected;
}

async function terminateProcesses(
  processes: AcpxProcessInfo[],
  deps: Required<Pick<AcpxProcessCleanupDeps, "killProcess" | "isProcessAlive" | "sleep">> & {
    forceAfterMs: number;
  },
): Promise<number[]> {
  const killedPids: number[] = [];
  for (const processInfo of processes) {
    if (!isPositivePid(processInfo.pid)) {
      continue;
    }
    try {
      await deps.killProcess(processInfo.pid, "SIGTERM");
      killedPids.push(processInfo.pid);
    } catch {
      // Best-effort cleanup: the process may already be gone or not signalable.
    }
  }

  if (deps.forceAfterMs > 0) {
    await deps.sleep(deps.forceAfterMs);
  }

  for (const processInfo of processes) {
    if (!deps.isProcessAlive(processInfo.pid)) {
      continue;
    }
    try {
      await deps.killProcess(processInfo.pid, "SIGKILL");
    } catch {
      // Best-effort cleanup: ignore late races and permission failures.
    }
  }
  return killedPids;
}

function resolveCleanupDeps(deps: AcpxProcessCleanupDeps): Required<AcpxProcessCleanupDeps> {
  return {
    listProcesses: deps.listProcesses ?? listUnixProcesses,
    killProcess: deps.killProcess ?? defaultKillProcess,
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    sleep: deps.sleep ?? defaultSleep,
    forceAfterMs: deps.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS,
  };
}

export async function cleanupOpenClawOwnedAcpxProcessTree(
  input: CleanupProcessTreeInput,
): Promise<AcpxProcessCleanupResult> {
  if (!isPositivePid(input.rootPid)) {
    return { inspectedPids: [], killedPids: [] };
  }
  const deps = resolveCleanupDeps(input);
  const processes = input.processes ?? (await deps.listProcesses());
  const rootProcess = processes.find((entry) => entry.pid === input.rootPid);
  const rootCommand = rootProcess?.command ?? input.rootCommand;
  if (!isOpenClawOwnedAcpxCommand(rootCommand)) {
    return { inspectedPids: rootProcess ? [rootProcess.pid] : [], killedPids: [] };
  }
  const tree = collectProcessTree(input.rootPid, processes);
  const inspectedPids = tree.map((entry) => entry.pid);
  const killedPids = await terminateProcesses(tree, deps);
  return { inspectedPids, killedPids };
}

export async function reapStaleOpenClawOwnedAcpxOrphans(
  input: ReapStaleOrphansInput = {},
): Promise<AcpxProcessCleanupResult> {
  const deps = resolveCleanupDeps(input);
  const processes = await deps.listProcesses();
  const roots = processes.filter(
    (processInfo) =>
      processInfo.ppid === 1 &&
      isOpenClawOwnedAcpxProcess(processInfo, {
        stateDir: input.stateDir,
      }),
  );
  const inspected = new Set<number>();
  const killed: number[] = [];

  for (const root of roots) {
    const tree = collectProcessTree(root.pid, processes);
    for (const processInfo of tree) {
      inspected.add(processInfo.pid);
    }
    killed.push(...(await terminateProcesses(tree, deps)));
  }

  return {
    inspectedPids: [...inspected],
    killedPids: killed,
  };
}
