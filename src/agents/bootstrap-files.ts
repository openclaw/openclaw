import type { OpenClawConfig } from "../config/config.js";
import { appendAppProfileBootstrapFile } from "./app-profile-context.js";
import { isAppUserSession } from "./app-user-workspace.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { appendMemoryRecallBootstrapFile } from "./memory-recall-context.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  applyAppBootstrapVariants,
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
  warn?: (message: string) => void;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );

  const withHooks = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });

  // App-user sessions only: drop boilerplate files and prefer lean `<name>.app.md` variants.
  // Runs AFTER hooks so a bootstrap hook (e.g. the bundled bootstrap-extra-files hook) cannot
  // re-introduce an excluded file (TOOLS/MEMORY/USER/IDENTITY/HEARTBEAT) or revert the `.app.md`
  // swap into an app prompt — preserving the app privacy/slimming guarantee (codex #82 P2).
  // Telegram/owner sessions skip this entirely → their assembled prompt is byte-identical.
  const shaped = isAppUserSession(sessionKey)
    ? await applyAppBootstrapVariants(withHooks, params.workspaceDir, params.warn)
    : withHooks;

  // Phase 3: inject the per-user app_profile as a synthetic APP_PROFILE.md context file for
  // app-user sessions (no-op otherwise). After shaping so it is neither excluded nor swapped;
  // before the buildBootstrapContextFiles clamp so it is budgeted too.
  const withProfile = await appendAppProfileBootstrapFile(shaped, {
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
  });

  // Deterministic durable-memory recall: inject the user's top Graphiti facts as a synthetic
  // MEMORY_RECALL.md so a returning user is recalled even when the agent doesn't search itself
  // (report 4A). App-sessions only; timeboxed + fail-open (never blocks the turn).
  return appendMemoryRecallBootstrapFile(withProfile, { sessionKey: params.sessionKey });
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
