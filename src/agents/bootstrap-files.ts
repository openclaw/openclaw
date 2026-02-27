import type { OpenClawConfig } from "../config/config.js";
import { resolveExplicitAgentDir } from "./agent-scope.js";
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

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = filterBootstrapFilesForSession(rawFiles, sessionKey);

  // When the agent has an *explicit* agentDir in its config, load bootstrap
  // files from that directory and let them override the shared workspace
  // copies.  This allows per-agent customisation (e.g. a distinct SOUL.md or
  // AGENTS.md) without touching the shared workspace directory.  We only
  // honour explicitly configured paths to avoid accidental overrides from
  // files that happen to exist under the default state directory.  See: #29387
  const agentDir =
    params.agentId && params.config
      ? resolveExplicitAgentDir(params.config, params.agentId)
      : undefined;
  let merged = bootstrapFiles;
  if (agentDir) {
    const agentDirFiles = await loadWorkspaceBootstrapFiles(agentDir);
    const overrides = new Map(agentDirFiles.filter((f) => !f.missing).map((f) => [f.name, f]));
    if (overrides.size > 0) {
      const existingNames = new Set(bootstrapFiles.map((f) => f.name));
      // Replace workspace files that have an agentDir counterpart
      merged = bootstrapFiles.map((f) => overrides.get(f.name) ?? f);
      // Append agentDir-only files that don't exist in the workspace at all
      // (e.g. MEMORY.md present only in the agent directory).  We must honour
      // the same session-level allowlist that was applied to the workspace
      // files above, otherwise agentDir-only files like MEMORY.md or
      // HEARTBEAT.md would bypass the minimal-session guard for subagent/cron
      // sessions.
      const added = filterBootstrapFilesForSession(
        [...overrides.values()].filter((f) => !existingNames.has(f.name)),
        sessionKey,
      );
      merged = [...merged, ...added];
      const overrideNames = Array.from(overrides.keys()).join(", ");
      params.warn?.(`bootstrap files from agentDir override workspace copies: ${overrideNames}`);
    }
  }

  // Apply hook overrides *after* agentDir merging so that hooks always have
  // the final say — this preserves the existing hook-based customisation
  // contract even when agentDir files are present.
  const updated = await applyBootstrapHookOverrides({
    files: merged,
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
