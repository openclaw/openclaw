/**
 * ACPX process ownership checks and cleanup. The reaper only terminates
 * OpenClaw-owned wrapper trees after validating paths, packages, and lease ids.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { splitCommandParts } from "./command-line.js";
import { resolveAcpxPluginRoot } from "./config.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import { OPENCLAW_ACPX_LEASE_ID_ENV, OPENCLAW_GATEWAY_INSTANCE_ID_ENV } from "./process-lease.js";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const GENERATED_WRAPPER_BASENAMES = new Set([
  "codex-acp-wrapper.mjs",
  "claude-agent-acp-wrapper.mjs",
]);
const OPENCLAW_PLUGIN_DEPS_MARKER = "/plugin-runtime-deps/";
const OWNED_ACP_PACKAGE_NAMES = [
  "@zed-industries/codex-acp",
  "@zed-industries/codex-acp-darwin-arm64",
  "@zed-industries/codex-acp-darwin-x64",
  "@zed-industries/codex-acp-linux-arm64",
  "@zed-industries/codex-acp-linux-x64",
  "@zed-industries/codex-acp-win32-arm64",
  "@zed-industries/codex-acp-win32-x64",
  "@agentclientprotocol/claude-agent-acp",
  "acpx",
];
const ACP_PACKAGE_MARKERS = [
  ...OWNED_ACP_PACKAGE_NAMES.map((packageName) => `/node_modules/${packageName}/`),
  "/acpx/dist/",
];

/** Minimal process-table row used by ACPX cleanup. */
export type AcpxProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

/** Injectable process-listing and termination hooks for tests. */
export type AcpxProcessCleanupDeps = {
  listProcesses?: () => Promise<AcpxProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

/** Result from cleaning up a single ACPX process tree. */
type AcpxProcessCleanupResult = {
  inspectedPids: number[];
  terminatedPids: number[];
  survivingPids?: number[];
  skippedReason?:
    | "missing-root"
    | "not-openclaw-owned"
    | "process-list-unavailable"
    | "unverified-root";
};

/** Result from startup orphan reaping. */
type AcpxStartupReapResult = {
  inspectedPids: number[];
  terminatedPids: number[];
  survivingPids?: number[];
  skippedReason?: "process-list-unavailable";
};

function normalizePathLike(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolvePackageRoot(packageName: string): string | undefined {
  try {
    return normalizePathLike(path.dirname(requireFromHere.resolve(`${packageName}/package.json`)));
  } catch {
    return undefined;
  }
}

function resolveOpenClawInstallRoot(pluginRoot: string): string {
  if (
    path.basename(pluginRoot) === "acpx" &&
    path.basename(path.dirname(pluginRoot)) === "extensions"
  ) {
    const parent = path.dirname(path.dirname(pluginRoot));
    return path.basename(parent) === "dist" ? path.dirname(parent) : parent;
  }
  return path.resolve(pluginRoot, "..");
}

function resolveOwnedAcpPackageRootCandidates(packageName: string): string[] {
  const pluginRoot = resolveAcpxPluginRoot(import.meta.url);
  const openClawRoot = resolveOpenClawInstallRoot(pluginRoot);
  return [
    resolvePackageRoot(packageName),
    path.join(pluginRoot, "node_modules", packageName),
    path.join(openClawRoot, "node_modules", packageName),
  ].flatMap((root) => (root ? [normalizePathLike(root)] : []));
}

const OWNED_ACP_PACKAGE_ROOTS = Array.from(
  new Set(OWNED_ACP_PACKAGE_NAMES.flatMap(resolveOwnedAcpPackageRootCandidates)),
);

function commandBelongsToResolvedAcpPackage(command: string): boolean {
  return OWNED_ACP_PACKAGE_ROOTS.some((root) => command.includes(`${root}/`));
}

function commandMentionsGeneratedWrapper(command: string): boolean {
  return Array.from(GENERATED_WRAPPER_BASENAMES).some((basename) => command.includes(basename));
}

function commandWrapperBelongsToRoot(command: string, wrapperRoot: string | undefined): boolean {
  if (!wrapperRoot) {
    return true;
  }
  const normalizedCommand = normalizePathLike(command);
  const normalizedRoot = normalizePathLike(wrapperRoot).replace(/\/+$/, "");
  return Array.from(GENERATED_WRAPPER_BASENAMES).some((basename) =>
    normalizedCommand.includes(`${normalizedRoot}/${basename}`),
  );
}

/** Check whether a command references an OpenClaw-generated ACPX wrapper path. */
export function isOpenClawLeaseAwareAcpxProcessCommand(params: {
  command: string | undefined;
  wrapperRoot?: string;
}): boolean {
  const command = params.command?.trim();
  if (!command) {
    return false;
  }
  const normalized = normalizePathLike(command);
  return (
    commandMentionsGeneratedWrapper(normalized) &&
    commandWrapperBelongsToRoot(normalized, params.wrapperRoot)
  );
}

function commandsReferToSameRootCommand(liveCommand: string, storedCommand: string | undefined) {
  if (!storedCommand?.trim()) {
    return true;
  }
  return normalizePathLike(liveCommand).trim() === normalizePathLike(storedCommand).trim();
}

function commandOptionEquals(
  parts: string[],
  option: string,
  expected: string | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  const index = parts.indexOf(option);
  return index >= 0 && parts[index + 1] === expected;
}

function liveCommandMatchesLeaseIdentity(params: {
  command: string | undefined;
  expectedLeaseId?: string;
  expectedGatewayInstanceId?: string;
}): boolean {
  if (!params.expectedLeaseId && !params.expectedGatewayInstanceId) {
    return true;
  }
  const parts = splitCommandParts(params.command ?? "");
  return (
    commandOptionEquals(parts, OPENCLAW_ACPX_LEASE_ID_ARG, params.expectedLeaseId) &&
    commandOptionEquals(parts, OPENCLAW_GATEWAY_INSTANCE_ID_ARG, params.expectedGatewayInstanceId)
  );
}

/** Check whether a command is owned by OpenClaw ACPX runtime packages or wrappers. */
export function isOpenClawOwnedAcpxProcessCommand(params: {
  command: string | undefined;
  wrapperRoot?: string;
}): boolean {
  const command = params.command?.trim();
  if (!command) {
    return false;
  }
  const normalized = normalizePathLike(command);
  if (
    isOpenClawLeaseAwareAcpxProcessCommand({
      command: normalized,
      wrapperRoot: params.wrapperRoot,
    })
  ) {
    return true;
  }
  if (commandBelongsToResolvedAcpPackage(normalized)) {
    return true;
  }
  if (!normalized.includes(OPENCLAW_PLUGIN_DEPS_MARKER)) {
    return false;
  }
  return ACP_PACKAGE_MARKERS.some((marker) => normalized.includes(marker));
}

function parseProcessList(stdout: string): AcpxProcessInfo[] {
  const processes: AcpxProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<command>.+?)\s*$/.exec(line);
    const pid = match?.groups?.pid;
    const ppid = match?.groups?.ppid;
    const command = match?.groups?.command;
    if (!pid || !ppid || !command) {
      continue;
    }
    processes.push({
      pid: Number.parseInt(pid, 10),
      ppid: Number.parseInt(ppid, 10),
      command,
    });
  }
  return processes;
}

/** List host processes in the compact shape needed by ACPX cleanup. */
async function listPlatformProcesses(): Promise<AcpxProcessInfo[]> {
  if (process.platform === "win32") {
    const script = [
      "Get-CimInstance Win32_Process",
      "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const raw = stdout.trim();
    return parseWindowsProcessList(raw);
  }
  // `eww` includes inherited environment markers in the command column. Never
  // log this output: it may contain unrelated process environment values.
  const { stdout } = await execFileAsync("ps", ["eww", "-axo", "pid=,ppid=,command="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseProcessList(stdout);
}

function parseWindowsProcessList(raw: string): AcpxProcessInfo[] {
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as
    | {
        ProcessId?: number;
        ParentProcessId?: number;
        CommandLine?: string | null;
        ExecutablePath?: string | null;
      }
    | Array<{
        ProcessId?: number;
        ParentProcessId?: number;
        CommandLine?: string | null;
        ExecutablePath?: string | null;
      }>;
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((entry) => {
    const pid = Number(entry.ProcessId);
    const ppid = Number(entry.ParentProcessId);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid) || ppid < 0) {
      return [];
    }
    return [
      {
        pid,
        ppid,
        command: entry.CommandLine?.trim() || entry.ExecutablePath?.trim() || "",
      },
    ];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandHasEnvironmentValue(command: string, key: string, expected: string): boolean {
  return new RegExp(`(?:^|\\s)${escapeRegExp(key)}=${escapeRegExp(expected)}(?:\\s|$)`).test(
    command,
  );
}

function processMatchesLeaseIdentity(params: {
  processInfo: AcpxProcessInfo;
  expectedLeaseId: string | undefined;
  expectedGatewayInstanceId: string | undefined;
}): boolean {
  if (!params.expectedLeaseId || !params.expectedGatewayInstanceId) {
    return false;
  }
  return (
    commandHasEnvironmentValue(
      params.processInfo.command,
      OPENCLAW_ACPX_LEASE_ID_ENV,
      params.expectedLeaseId,
    ) &&
    commandHasEnvironmentValue(
      params.processInfo.command,
      OPENCLAW_GATEWAY_INSTANCE_ID_ENV,
      params.expectedGatewayInstanceId,
    )
  );
}

function collectLeaseProcesses(params: {
  processes: AcpxProcessInfo[];
  expectedLeaseId: string | undefined;
  expectedGatewayInstanceId: string | undefined;
}): AcpxProcessInfo[] {
  return params.processes.filter((processInfo) =>
    processMatchesLeaseIdentity({
      processInfo,
      expectedLeaseId: params.expectedLeaseId,
      expectedGatewayInstanceId: params.expectedGatewayInstanceId,
    }),
  );
}

function collectProcessTree(processes: AcpxProcessInfo[], rootPid: number): AcpxProcessInfo[] {
  const childrenByParent = new Map<number, AcpxProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.ppid, children);
  }

  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const root = byPid.get(rootPid);
  const collected: AcpxProcessInfo[] = [];
  if (root) {
    collected.push(root);
  }

  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || collected.some((processInfo) => processInfo.pid === next.pid)) {
      continue;
    }
    collected.push(next);
    queue.push(...(childrenByParent.get(next.pid) ?? []));
  }

  return collected;
}

function uniquePids(processes: AcpxProcessInfo[]): number[] {
  return Array.from(
    new Set(
      processes
        .map((processInfo) => processInfo.pid)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
    ),
  );
}

function uniqueProcesses(processes: AcpxProcessInfo[]): AcpxProcessInfo[] {
  return Array.from(
    new Map(
      processes
        .filter(
          (processInfo) =>
            Number.isInteger(processInfo.pid) &&
            processInfo.pid > 0 &&
            processInfo.pid !== process.pid,
        )
        .map((processInfo) => [processInfo.pid, processInfo]),
    ).values(),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcesses(
  targets: AcpxProcessInfo[],
  deps: AcpxProcessCleanupDeps | undefined,
  matchesIdentity: (current: AcpxProcessInfo, target: AcpxProcessInfo) => boolean,
): Promise<{ terminatedPids: number[]; survivingPids: number[] }> {
  const killProcess = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const checkAlive = deps?.isProcessAlive ?? isProcessAlive;
  const listProcesses = deps?.listProcesses ?? listPlatformProcesses;
  const sleep =
    deps?.sleep ??
    ((ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const targeted = uniqueProcesses(targets);

  for (const target of targeted) {
    try {
      killProcess(target.pid, "SIGTERM");
    } catch {
      // Liveness verification below distinguishes already-gone processes from failures.
    }
  }
  if (targeted.length === 0) {
    return { terminatedPids: [], survivingPids: [] };
  }
  await sleep(750);
  let escalationInventory: Map<number, AcpxProcessInfo> | undefined;
  try {
    escalationInventory = new Map((await listProcesses()).map((entry) => [entry.pid, entry]));
  } catch {
    // Without fresh identity evidence, do not escalate a numeric PID.
  }
  for (const target of targeted) {
    const current = escalationInventory?.get(target.pid);
    if (current && matchesIdentity(current, target) && checkAlive(target.pid)) {
      try {
        killProcess(target.pid, "SIGKILL");
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
  await sleep(250);
  let finalInventory: Map<number, AcpxProcessInfo> | undefined;
  try {
    finalInventory = new Map((await listProcesses()).map((entry) => [entry.pid, entry]));
  } catch {
    // Numeric liveness below keeps unverifiable targets in the survivor set.
  }
  const survivingPids: number[] = [];
  const terminatedPids: number[] = [];
  for (const target of targeted) {
    if (!checkAlive(target.pid)) {
      terminatedPids.push(target.pid);
      continue;
    }
    const current = finalInventory?.get(target.pid);
    if (finalInventory && (!current || !matchesIdentity(current, target))) {
      terminatedPids.push(target.pid);
      continue;
    }
    survivingPids.push(target.pid);
  }
  return {
    terminatedPids,
    survivingPids,
  };
}

/** Terminate one validated OpenClaw-owned ACPX wrapper process tree. */
export async function cleanupOpenClawOwnedAcpxProcessTree(params: {
  rootPid?: number;
  rootCommand?: string;
  expectedLeaseId?: string;
  expectedGatewayInstanceId?: string;
  wrapperRoot?: string;
  deps?: AcpxProcessCleanupDeps;
}): Promise<AcpxProcessCleanupResult> {
  const rootPid = params.rootPid;
  if (!rootPid || rootPid <= 0 || rootPid === process.pid) {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "missing-root" };
  }

  let processes: AcpxProcessInfo[];
  try {
    processes = await (params.deps?.listProcesses ?? listPlatformProcesses)();
  } catch {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "process-list-unavailable" };
  }

  const listedTree = collectProcessTree(processes, rootPid);
  const leaseProcesses = collectLeaseProcesses({
    processes,
    expectedLeaseId: params.expectedLeaseId,
    expectedGatewayInstanceId: params.expectedGatewayInstanceId,
  });
  const matchesCleanupIdentity = (current: AcpxProcessInfo, target: AcpxProcessInfo) => {
    if (params.expectedLeaseId && params.expectedGatewayInstanceId) {
      const targetHasLeaseIdentity =
        processMatchesLeaseIdentity({
          processInfo: target,
          expectedLeaseId: params.expectedLeaseId,
          expectedGatewayInstanceId: params.expectedGatewayInstanceId,
        }) ||
        liveCommandMatchesLeaseIdentity({
          command: target.command,
          expectedLeaseId: params.expectedLeaseId,
          expectedGatewayInstanceId: params.expectedGatewayInstanceId,
        });
      if (targetHasLeaseIdentity) {
        return (
          processMatchesLeaseIdentity({
            processInfo: current,
            expectedLeaseId: params.expectedLeaseId,
            expectedGatewayInstanceId: params.expectedGatewayInstanceId,
          }) ||
          liveCommandMatchesLeaseIdentity({
            command: current.command,
            expectedLeaseId: params.expectedLeaseId,
            expectedGatewayInstanceId: params.expectedGatewayInstanceId,
          })
        );
      }
      // Windows process inventory cannot expose inherited environment values.
      // Descendants discovered through a validated PPID tree therefore retain
      // an exact command + parent identity check before delayed escalation.
      return (
        current.ppid === target.ppid &&
        normalizePathLike(current.command).trim() === normalizePathLike(target.command).trim()
      );
    }
    return normalizePathLike(current.command).trim() === normalizePathLike(target.command).trim();
  };
  // Session-store PIDs are stale data. If the live process table cannot prove
  // that this PID still belongs to an OpenClaw-owned wrapper, fail closed to
  // avoid killing an unrelated process after PID reuse.
  if (listedTree.length === 0 && leaseProcesses.length === 0) {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "missing-root" };
  }
  if (listedTree.length === 0) {
    const termination = await terminateProcesses(
      leaseProcesses.toReversed(),
      params.deps,
      matchesCleanupIdentity,
    );
    return {
      inspectedPids: uniquePids(leaseProcesses),
      terminatedPids: termination.terminatedPids,
      ...(termination.survivingPids.length > 0 ? { survivingPids: termination.survivingPids } : {}),
    };
  }
  const rootCommand = listedTree[0]?.command ?? params.rootCommand;
  const liveCommandWasGeneratedWrapper = commandMentionsGeneratedWrapper(
    normalizePathLike(rootCommand ?? ""),
  );
  const storedCommandWasGeneratedWrapper = commandMentionsGeneratedWrapper(
    normalizePathLike(params.rootCommand ?? ""),
  );
  if (!liveCommandWasGeneratedWrapper && storedCommandWasGeneratedWrapper) {
    return {
      inspectedPids: listedTree.map((processInfo) => processInfo.pid),
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    };
  }
  if (
    !liveCommandWasGeneratedWrapper &&
    !commandsReferToSameRootCommand(rootCommand ?? "", params.rootCommand)
  ) {
    return {
      inspectedPids: listedTree.map((processInfo) => processInfo.pid),
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    };
  }
  if (
    !isOpenClawOwnedAcpxProcessCommand({
      command: rootCommand,
      wrapperRoot: params.wrapperRoot,
    })
  ) {
    return {
      inspectedPids: listedTree.map((processInfo) => processInfo.pid),
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    };
  }
  if (
    !liveCommandMatchesLeaseIdentity({
      command: rootCommand,
      expectedLeaseId: params.expectedLeaseId,
      expectedGatewayInstanceId: params.expectedGatewayInstanceId,
    })
  ) {
    return {
      inspectedPids: listedTree.map((processInfo) => processInfo.pid),
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    };
  }

  const inspected = Array.from(
    new Map(
      [...listedTree, ...leaseProcesses].map((processInfo) => [processInfo.pid, processInfo]),
    ).values(),
  );
  const targets = uniqueProcesses([
    ...leaseProcesses.filter((processInfo) => processInfo.pid !== rootPid).toReversed(),
    ...listedTree.toReversed(),
  ]);
  const termination = await terminateProcesses(targets, params.deps, matchesCleanupIdentity);
  return {
    inspectedPids: uniquePids(inspected),
    terminatedPids: termination.terminatedPids,
    ...(termination.survivingPids.length > 0 ? { survivingPids: termination.survivingPids } : {}),
  };
}

/** Reap orphaned OpenClaw-owned ACPX wrapper trees during runtime startup. */
export async function reapStaleOpenClawOwnedAcpxOrphans(params: {
  wrapperRoot: string;
  deps?: AcpxProcessCleanupDeps;
}): Promise<AcpxStartupReapResult> {
  let processes: AcpxProcessInfo[];
  try {
    processes = await (params.deps?.listProcesses ?? listPlatformProcesses)();
  } catch {
    return { inspectedPids: [], terminatedPids: [], skippedReason: "process-list-unavailable" };
  }

  const orphans = processes.filter(
    (processInfo) =>
      (process.platform === "win32" || processInfo.ppid === 1) &&
      isOpenClawOwnedAcpxProcessCommand({
        command: processInfo.command,
        wrapperRoot: params.wrapperRoot,
      }),
  );
  // Startup reaping starts from currently visible orphan roots and then expands
  // each tree, so adapter grandchildren do not survive as fresh orphans after
  // the wrapper root exits.
  const orphanTrees = orphans.map((orphan) => collectProcessTree(processes, orphan.pid));
  const inspectedPids = uniquePids(orphanTrees.flat());
  const targets = uniqueProcesses(orphanTrees.flatMap((tree) => tree.toReversed()));
  const termination = await terminateProcesses(
    targets,
    params.deps,
    (current, target) =>
      normalizePathLike(current.command).trim() === normalizePathLike(target.command).trim(),
  );
  return {
    inspectedPids,
    terminatedPids: termination.terminatedPids,
    ...(termination.survivingPids.length > 0 ? { survivingPids: termination.survivingPids } : {}),
  };
}

export const testing = {
  parseWindowsProcessList,
};
