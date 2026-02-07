import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { createArtifactRegistry } from "../artifacts/artifact-registry.js";
import { resolveStateDir } from "../config/paths.js";
import { parseBooleanValue } from "../utils/boolean.js";
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

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );
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
  const maxChars = resolveBootstrapMaxChars(params.config);

  const artifactRefsEnabled = parseBooleanValue(process.env.OPENCLAW_ARTIFACT_REFS) ?? false;
  const artifactThresholdChars = Number.parseInt(
    process.env.OPENCLAW_ARTIFACT_REFS_THRESHOLD_CHARS ?? "",
    10,
  );
  const thresholdChars =
    Number.isFinite(artifactThresholdChars) && artifactThresholdChars > 0
      ? artifactThresholdChars
      : Math.max(8000, maxChars);

  const artifactRefs = artifactRefsEnabled
    ? {
        enabled: true,
        thresholdChars,
        registry: createArtifactRegistry({
          rootDir: path.join(resolveStateDir(process.env), "artifacts"),
        }),
        mime: "text/markdown",
      }
    : undefined;

  const contextFiles = await buildBootstrapContextFiles(bootstrapFiles, {
    maxChars,
    warn: params.warn,
    artifactRefs,
  });
  return { bootstrapFiles, contextFiles };
}
