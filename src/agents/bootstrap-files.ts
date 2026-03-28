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

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

/**
 * Workspace scope for subagents - controls which bootstrap files are injected.
 * - "full": All bootstrap files (AGENTS.md, MEMORY.md, SOUL.md, etc.)
 * - "essential": AGENTS.md, TOOLS.md, BOOTSTRAP.md only
 * - "minimal": BOOTSTRAP.md only
 * - "none": No workspace context injected
 */
export type SubagentWorkspaceScope = "full" | "essential" | "minimal" | "none";

const ESSENTIAL_BOOTSTRAP_FILES = new Set(["AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"]);
const MINIMAL_BOOTSTRAP_FILES = new Set(["BOOTSTRAP.md"]);

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
 * Filter bootstrap files based on subagent workspace scope.
 * Used to reduce token consumption for narrow, stateless subagent tasks.
 */
export function applySubagentWorkspaceScopeFilter(params: {
  files: WorkspaceBootstrapFile[];
  scope?: SubagentWorkspaceScope;
  customFiles?: string[];
}): WorkspaceBootstrapFile[] {
  // If custom allowlist is provided, use it exclusively
  if (params.customFiles && params.customFiles.length > 0) {
    const customSet = new Set(params.customFiles);
    return params.files.filter((file) => customSet.has(file.name));
  }

  const scope = params.scope ?? "full";
  
  switch (scope) {
    case "none":
      return [];
    case "minimal":
      return params.files.filter((file) => MINIMAL_BOOTSTRAP_FILES.has(file.name));
    case "essential":
      return params.files.filter((file) => ESSENTIAL_BOOTSTRAP_FILES.has(file.name));
    case "full":
    default:
      return params.files;
  }
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
  /** Optional workspace scope filter for subagents (reduces token usage). */
  subagentWorkspaceScope?: SubagentWorkspaceScope;
  /** Optional custom allowlist of bootstrap files (overrides subagentWorkspaceScope). */
  subagentWorkspaceFiles?: string[];
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  let bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });
  
  // Apply subagent workspace scope filter if specified
  if (params.subagentWorkspaceScope || params.subagentWorkspaceFiles) {
    bootstrapFiles = applySubagentWorkspaceScopeFilter({
      files: bootstrapFiles,
      scope: params.subagentWorkspaceScope,
      customFiles: params.subagentWorkspaceFiles,
    });
  }

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
  /** Optional workspace scope filter for subagents (reduces token usage). */
  subagentWorkspaceScope?: SubagentWorkspaceScope;
  /** Optional custom allowlist of bootstrap files (overrides subagentWorkspaceScope). */
  subagentWorkspaceFiles?: string[];
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
