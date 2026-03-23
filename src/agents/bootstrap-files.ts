import type { OpenClawConfig } from "../config/config.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  filterBootstrapFilesForSession,
  isWorkspaceSetupCompleted,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    sanitized.push({ ...file, path: pathValue });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  const runKind = params.runKind ?? "default";
  if (contextMode !== "lightweight") {
    return params.files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === DEFAULT_HEARTBEAT_FILENAME);
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

function excludeHeartbeatFromFullContext(
  files: WorkspaceBootstrapFile[],
  contextMode?: BootstrapContextMode,
): WorkspaceBootstrapFile[] {
  if ((contextMode ?? "full") === "lightweight") {
    return files;
  }
  return files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
}

async function excludeCompletedBootstrapFromMainContext(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  sessionKey?: string;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  if ((params.contextMode ?? "full") === "lightweight") {
    return params.files;
  }
  if ((params.runKind ?? "default") !== "default") {
    return params.files;
  }
  if (
    params.sessionKey &&
    (isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey))
  ) {
    return params.files;
  }
  try {
    if (!(await isWorkspaceSetupCompleted(params.workspaceDir))) {
      return params.files;
    }
  } catch {
    return params.files;
  }
  return params.files.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  const withoutHeartbeat = excludeHeartbeatFromFullContext(updated, params.contextMode);
  const filtered = await excludeCompletedBootstrapFromMainContext({
    files: withoutHeartbeat,
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    contextMode: params.contextMode,
    runKind: params.runKind,
  });
  return sanitizeBootstrapFiles(filtered, params.warn);
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
