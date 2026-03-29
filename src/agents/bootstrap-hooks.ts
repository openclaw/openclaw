import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function cloneBootstrapFiles(files: WorkspaceBootstrapFile[]): WorkspaceBootstrapFile[] {
  return files.map((file) => ({ ...file }));
}

function normalizeBootstrapFilePath(filePath: string): string {
  return path.normalize(filePath.trim()).replace(/\\/g, "/");
}

function dedupeBootstrapFilesByNormalizedPath(
  files: WorkspaceBootstrapFile[],
): WorkspaceBootstrapFile[] {
  const deduped: WorkspaceBootstrapFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    if (!pathValue) {
      deduped.push({ ...file });
      continue;
    }
    const normalizedPath = normalizeBootstrapFilePath(pathValue);
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);
    deduped.push({ ...file, path: pathValue });
  }
  return deduped;
}

export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const context: AgentBootstrapHookContext = {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: cloneBootstrapFiles(params.files),
    cfg: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId,
  };
  const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
  await triggerInternalHook(event);
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  if (!Array.isArray(updated)) {
    return cloneBootstrapFiles(params.files);
  }
  return dedupeBootstrapFilesByNormalizedPath(updated);
}
