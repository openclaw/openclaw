import fs from "node:fs/promises";
import { log } from "../logger.js";
import type { AgentDefaultsConfig } from "../../../config/types.agent-defaults.js";

/**
 * Resolves the final workspace injection mode based on configuration.
 * Returns 'first-message-only' as the default if not specified.
 */
export function resolveWorkspaceInjectionMode(config?: AgentDefaultsConfig): "always" | "first-message-only" {
  const mode = config?.workspaceInjection;
  if (!mode || mode === "first-message-only") {
    return "first-message-only";
  }
  return "always";
}

/**
 * Checks if the bootstrap files should be loaded based on the injection mode
 * and whether the session file already exists.
 * 
 * If the mode is 'first-message-only', it returns true only if the session file
 * DOES NOT exist yet (meaning it's the first turn).
 */
export async function shouldLoadBootstrapFiles({
  sessionFile,
  config,
}: {
  sessionFile: string;
  config?: AgentDefaultsConfig;
}): Promise<boolean> {
  const mode = resolveWorkspaceInjectionMode(config);
  
  if (mode === "always") {
    return true;
  }

  try {
    // Check if the session file exists.
    // If it exists, this is NOT the first turn, so we skip bootstrap injection.
    await fs.stat(sessionFile);
    log.debug(`[workspace-injection] Skipping bootstrap loading for existing session: ${sessionFile}`);
    return false;
  } catch (err) {
    // If stat fails, the file likely doesn't exist, meaning it's the first turn.
    log.debug(`[workspace-injection] First turn detected, loading bootstrap files: ${sessionFile}`);
    return true;
  }
}
