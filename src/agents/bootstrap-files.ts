import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const SESSION_HEAD_MAX_BYTES = 16384;
const SESSION_HEAD_MAX_LINES = 100;

/**
 * Check whether a Pi session file already contains at least one assistant
 * message. Reads only the first chunk of the file to avoid loading the entire
 * transcript into memory.
 */
export async function sessionHasAssistantMessages(sessionFile: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(sessionFile, "r");
    const buf = Buffer.alloc(SESSION_HEAD_MAX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead <= 0) {
      return false;
    }
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/).slice(0, SESSION_HEAD_MAX_LINES);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed?.message?.role === "assistant") {
          return true;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file doesn't exist or can't be read — treat as no history
  } finally {
    await handle?.close();
  }
  return false;
}

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";
export type ContextInjectionMode = "always" | "first-message-only";

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
    return params.files;
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === "HEARTBEAT.md");
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

/**
 * Apply context injection mode filtering. When mode is "first-message-only"
 * and the session already has assistant messages, skip all context files
 * to save tokens on subsequent messages.
 */
export function applyContextInjectionFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextInjection?: ContextInjectionMode;
  hasExistingAssistantMessages: boolean;
}): WorkspaceBootstrapFile[] {
  const mode = params.contextInjection ?? "always";
  if (mode === "first-message-only" && params.hasExistingAssistantMessages) {
    return [];
  }
  return params.files;
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
  contextInjection?: ContextInjectionMode;
  hasExistingAssistantMessages?: boolean;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const modeFiltered = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });
  const bootstrapFiles = applyContextInjectionFilter({
    files: modeFiltered,
    contextInjection: params.contextInjection,
    hasExistingAssistantMessages: params.hasExistingAssistantMessages ?? false,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return sanitizeBootstrapFiles(updated, params.warn);
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
  contextInjection?: ContextInjectionMode;
  hasExistingAssistantMessages?: boolean;
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
