import fs from "node:fs/promises";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { resolveContinuityRollupPath } from "../continuity/rollup.js";
import { isGroupChannelSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars } from "./pi-embedded-helpers.js";
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

async function loadContinuityRollupFile(agentId: string): Promise<WorkspaceBootstrapFile | null> {
  const rollupPath = resolveContinuityRollupPath(agentId);
  try {
    const content = await fs.readFile(rollupPath, "utf-8");
    if (!content.trim()) {
      return null;
    }
    return {
      name: "ROLLUP.md",
      path: rollupPath,
      content,
      missing: false,
    };
  } catch {
    return null;
  }
}

function injectContinuityRollup(
  files: WorkspaceBootstrapFile[],
  rollup: WorkspaceBootstrapFile,
): WorkspaceBootstrapFile[] {
  const memoryIdx = files.findIndex(
    (file) => file.name === "MEMORY.md" || file.name === "memory.md",
  );
  if (memoryIdx < 0) {
    return [...files, rollup];
  }
  return [...files.slice(0, memoryIdx), rollup, ...files.slice(memoryIdx)];
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  let bootstrapFiles = await loadWorkspaceBootstrapFiles(params.workspaceDir);

  if (
    params.agentId &&
    !isGroupChannelSessionKey(sessionKey) &&
    !isSubagentSessionKey(sessionKey)
  ) {
    const rollup = await loadContinuityRollupFile(params.agentId);
    if (rollup) {
      bootstrapFiles = injectContinuityRollup(bootstrapFiles, rollup);
    }
  }

  bootstrapFiles = filterBootstrapFilesForSession(bootstrapFiles, sessionKey);

  return applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
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
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
