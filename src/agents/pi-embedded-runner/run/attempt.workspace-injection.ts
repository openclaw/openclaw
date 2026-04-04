/**
 * Workspace injection optimization for issue #9157.
 *
 * This module provides the logic to conditionally skip redundant
 * workspace file injection on subsequent messages in a conversation.
 *
 * The key insight: workspace files (AGENTS.md, SOUL.md, USER.md) are
 * static context that rarely changes during a conversation. After the
 * first message, the agent already has this context and can use the
 * `read` tool if it needs to re-check workspace files.
 */

import fs from "node:fs/promises";

export type WorkspaceInjectionMode = "first-message-only" | "always";

/**
 * Resolves the workspace injection mode from config.
 * Defaults to "first-message-only" for optimal token efficiency.
 */
export function resolveWorkspaceInjectionMode(
  config?: { agents?: { defaults?: { workspaceInjection?: string } } } | null,
): WorkspaceInjectionMode {
  const mode = config?.agents?.defaults?.workspaceInjection;
  if (mode === "always") {
    return "always";
  }
  return "first-message-only";
}

/**
 * Determines whether bootstrap workspace files should be loaded for this run.
 *
 * Returns true when:
 * - This is the first message (session file doesn't exist yet)
 * - Config explicitly sets workspaceInjection to "always"
 *
 * Returns false when:
 * - Session file exists AND mode is "first-message-only"
 */
export async function shouldLoadBootstrapFiles(params: {
  sessionFile: string;
  config?: { agents?: { defaults?: { workspaceInjection?: string } } } | null;
}): Promise<{ shouldLoad: boolean; hadSessionFile: boolean }> {
  const mode = resolveWorkspaceInjectionMode(params.config);

  // Always load if configured for legacy behavior
  if (mode === "always") {
    const hadSessionFile = await fs
      .stat(params.sessionFile)
      .then(() => true)
      .catch(() => false);
    return { shouldLoad: true, hadSessionFile };
  }

  // Check if session file exists (first message detection)
  const hadSessionFile = await fs
    .stat(params.sessionFile)
    .then(() => true)
    .catch(() => false);

  return {
    shouldLoad: !hadSessionFile,
    hadSessionFile,
  };
}
