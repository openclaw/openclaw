import path from "node:path";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";
import type { PreparedAgentRun } from "./runtime-backend.js";

export type AgentWorkerPermissionMode = "audit" | "enforce" | "off";

export type AgentWorkerPermissionProfile = {
  mode: AgentWorkerPermissionMode;
  fsRead: string[];
  fsWrite: string[];
  allowWorker: boolean;
  allowChildProcess: boolean;
  allowAddons: boolean;
  allowWasi: boolean;
};

export type CreateAgentWorkerPermissionProfileOptions = {
  mode?: AgentWorkerPermissionMode;
  env?: NodeJS.ProcessEnv;
  runtimeReadRoots?: string[];
};

function normalizePermissionPaths(paths: Iterable<string | undefined>): string[] {
  const normalized = new Set<string>();
  for (const candidate of paths) {
    if (!candidate?.trim()) {
      continue;
    }
    normalized.add(path.resolve(candidate));
  }
  return [...normalized].toSorted((left, right) => left.localeCompare(right));
}

export function createAgentWorkerPermissionProfile(
  preparedRun: PreparedAgentRun,
  options: CreateAgentWorkerPermissionProfileOptions = {},
): AgentWorkerPermissionProfile {
  const mode = options.mode ?? "off";
  const runtimeReadRoots = options.runtimeReadRoots ?? [process.cwd()];
  const stateDir = resolveOpenClawStateSqliteDir(options.env ?? process.env);
  const workspacePaths =
    preparedRun.filesystemMode === "vfs-only" ? [] : [preparedRun.workspaceDir];

  return {
    mode,
    fsRead: normalizePermissionPaths([...runtimeReadRoots, stateDir, ...workspacePaths]),
    fsWrite: normalizePermissionPaths([stateDir, ...workspacePaths]),
    allowWorker: false,
    allowChildProcess: false,
    allowAddons: false,
    allowWasi: false,
  };
}

export function buildNodePermissionExecArgv(profile?: AgentWorkerPermissionProfile): string[] {
  if (!profile || profile.mode === "off") {
    return [];
  }
  const args = [profile.mode === "audit" ? "--permission-audit" : "--permission"];
  for (const fsReadPath of profile.fsRead) {
    args.push(`--allow-fs-read=${fsReadPath}`);
  }
  for (const fsWritePath of profile.fsWrite) {
    args.push(`--allow-fs-write=${fsWritePath}`);
  }
  if (profile.allowWorker) {
    args.push("--allow-worker");
  }
  if (profile.allowChildProcess) {
    args.push("--allow-child-process");
  }
  if (profile.allowAddons) {
    args.push("--allow-addons");
  }
  if (profile.allowWasi) {
    args.push("--allow-wasi");
  }
  return args;
}
