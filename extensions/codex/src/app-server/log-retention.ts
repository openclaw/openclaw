import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerStartOptions } from "./config.js";

const CODEX_LOG_DATABASE = "logs_2.sqlite";
const CODEX_LOG_FILES = [CODEX_LOG_DATABASE, "logs_2.sqlite-wal", "logs_2.sqlite-shm"] as const;
const RETIRED_MARKER = ".retired.";
const RETIRED_SQLITE_WAL_SUFFIX = "-wal";
const RETIRED_SQLITE_SHM_SUFFIX = "-shm";

export const DEFAULT_CODEX_APP_SERVER_LOG_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS = 2;
export const CODEX_APP_SERVER_LOG_RETENTION_ENV = "OPENCLAW_CODEX_APP_SERVER_LOG_RETENTION";
export const CODEX_APP_SERVER_LOG_MAX_BYTES_ENV = "OPENCLAW_CODEX_APP_SERVER_LOG_MAX_BYTES";
export const CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS_ENV =
  "OPENCLAW_CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS";

export type CodexAppServerLogRetentionConfig = {
  enabled: boolean;
  maxBytes: number;
  retainedSnapshots: number;
};

export type CodexAppServerLogRetentionResult = {
  rotated: boolean;
  reason?: string;
  codexHome?: string;
  dbPath?: string;
  sizeBytes?: number;
  maxBytes?: number;
  rotatedFiles?: string[];
  prunedFiles?: number;
};

type ApplyCodexAppServerLogRetentionParams = {
  startOptions: CodexAppServerStartOptions;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

type RegularCodexLogFile = {
  fileName: (typeof CODEX_LOG_FILES)[number];
  filePath: string;
  sizeBytes: number;
};

export function resolveCodexAppServerLogRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): CodexAppServerLogRetentionConfig {
  return {
    enabled: !isDisabled(env[CODEX_APP_SERVER_LOG_RETENTION_ENV]),
    maxBytes: readPositiveIntegerEnv(
      env[CODEX_APP_SERVER_LOG_MAX_BYTES_ENV],
      DEFAULT_CODEX_APP_SERVER_LOG_MAX_BYTES,
    ),
    retainedSnapshots: readNonNegativeIntegerEnv(
      env[CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS_ENV],
      DEFAULT_CODEX_APP_SERVER_RETIRED_LOG_SNAPSHOTS,
    ),
  };
}

export async function applyCodexAppServerLogRetention(
  params: ApplyCodexAppServerLogRetentionParams,
): Promise<CodexAppServerLogRetentionResult> {
  try {
    const result = await applyCodexAppServerLogRetentionInternal(params);
    if (result.rotated) {
      embeddedAgentLog.warn("codex app-server log database rotated before startup", {
        codexHome: result.codexHome,
        dbPath: result.dbPath,
        sizeBytes: result.sizeBytes,
        maxBytes: result.maxBytes,
        rotatedFiles: result.rotatedFiles,
        prunedFiles: result.prunedFiles,
      });
    }
    return result;
  } catch (error) {
    embeddedAgentLog.warn("codex app-server log retention failed before startup", { error });
    return { rotated: false, reason: "retention_failed" };
  }
}

async function applyCodexAppServerLogRetentionInternal(
  params: ApplyCodexAppServerLogRetentionParams,
): Promise<CodexAppServerLogRetentionResult> {
  if (params.startOptions.transport !== "stdio") {
    return { rotated: false, reason: "non_stdio_transport" };
  }
  const config = resolveCodexAppServerLogRetentionConfig(params.env);
  if (!config.enabled) {
    return { rotated: false, reason: "disabled" };
  }
  const codexHome = params.startOptions.env?.CODEX_HOME?.trim();
  if (!codexHome) {
    return { rotated: false, reason: "missing_codex_home" };
  }
  const dbPath = path.join(codexHome, CODEX_LOG_DATABASE);
  const logFiles = await collectRegularCodexLogFiles(codexHome);
  if (!logFiles.some((file) => file.fileName === CODEX_LOG_DATABASE)) {
    return { rotated: false, reason: "missing_database", codexHome, dbPath };
  }
  const sizeBytes = logFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (sizeBytes <= config.maxBytes) {
    const prunedFiles = await pruneRetiredLogSnapshots(codexHome, config.retainedSnapshots);
    return {
      rotated: false,
      reason: "under_limit",
      codexHome,
      dbPath,
      sizeBytes,
      maxBytes: config.maxBytes,
      prunedFiles,
    };
  }

  const timestamp = formatRotationTimestamp(params.now?.() ?? new Date());
  const rotatedFiles: string[] = [];
  for (const file of logFiles) {
    const targetPath = path.join(codexHome, retiredLogTargetFileName(file.fileName, timestamp));
    await fs.rename(file.filePath, targetPath);
    rotatedFiles.push(targetPath);
  }
  const prunedFiles = await pruneRetiredLogSnapshots(codexHome, config.retainedSnapshots);

  return {
    rotated: rotatedFiles.length > 0,
    ...(rotatedFiles.length > 0 ? {} : { reason: "no_regular_log_files" }),
    codexHome,
    dbPath,
    sizeBytes,
    maxBytes: config.maxBytes,
    rotatedFiles,
    prunedFiles,
  };
}

async function collectRegularCodexLogFiles(codexHome: string): Promise<RegularCodexLogFile[]> {
  const files: RegularCodexLogFile[] = [];
  for (const fileName of CODEX_LOG_FILES) {
    const filePath = path.join(codexHome, fileName);
    const stat = await safeLstat(filePath);
    if (!stat?.isFile()) {
      continue;
    }
    files.push({ fileName, filePath, sizeBytes: Number(stat.size) });
  }
  return files;
}

async function safeLstat(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pruneRetiredLogSnapshots(
  codexHome: string,
  retainedSnapshots: number,
): Promise<number> {
  if (retainedSnapshots < 0) {
    return 0;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(codexHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  const snapshots = new Map<string, string[]>();
  for (const entry of entries) {
    const retired = parseRetiredLogEntry(entry);
    if (!retired) {
      continue;
    }
    const files = snapshots.get(retired.timestamp) ?? [];
    files.push(entry);
    snapshots.set(retired.timestamp, files);
  }
  const staleTimestamps = [...snapshots.keys()].toSorted().toReversed().slice(retainedSnapshots);
  let pruned = 0;
  for (const timestamp of staleTimestamps) {
    for (const fileName of snapshots.get(timestamp) ?? []) {
      await fs.unlink(path.join(codexHome, fileName));
      pruned += 1;
    }
  }
  return pruned;
}

function parseRetiredLogEntry(fileName: string): { timestamp: string } | null {
  const retiredDatabasePrefix = `${CODEX_LOG_DATABASE}${RETIRED_MARKER}`;
  if (!fileName.startsWith(retiredDatabasePrefix)) {
    return null;
  }
  const rawTimestamp = fileName.slice(retiredDatabasePrefix.length);
  const timestamp = rawTimestamp.endsWith(RETIRED_SQLITE_WAL_SUFFIX)
    ? rawTimestamp.slice(0, -RETIRED_SQLITE_WAL_SUFFIX.length)
    : rawTimestamp.endsWith(RETIRED_SQLITE_SHM_SUFFIX)
      ? rawTimestamp.slice(0, -RETIRED_SQLITE_SHM_SUFFIX.length)
      : rawTimestamp;
  return timestamp ? { timestamp } : null;
}

function retiredLogTargetFileName(
  fileName: (typeof CODEX_LOG_FILES)[number],
  timestamp: string,
): string {
  const retiredDatabaseName = `${CODEX_LOG_DATABASE}${RETIRED_MARKER}${timestamp}`;
  if (fileName === CODEX_LOG_DATABASE) {
    return retiredDatabaseName;
  }
  if (fileName === "logs_2.sqlite-wal") {
    return `${retiredDatabaseName}${RETIRED_SQLITE_WAL_SUFFIX}`;
  }
  return `${retiredDatabaseName}${RETIRED_SQLITE_SHM_SUFFIX}`;
}

function formatRotationTimestamp(date: Date): string {
  return date.toISOString().replace(/[.:]/gu, "-");
}

function isDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
  );
}

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
