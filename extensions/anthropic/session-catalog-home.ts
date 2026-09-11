import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveClaudeCatalogHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

// Node declarations expose Claude session commands only when this machine owns a
// Claude session store; otherwise the gateway must skip the node capability.
export function claudeProjectsAvailable(env: NodeJS.ProcessEnv): boolean {
  const homeDir = resolveClaudeCatalogHomeDir(env);
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  try {
    return statSync(
      path.join(configDir ? path.resolve(configDir) : path.join(homeDir, ".claude"), "projects"),
    ).isDirectory();
  } catch {
    return false;
  }
}
