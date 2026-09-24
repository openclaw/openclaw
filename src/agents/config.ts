/** Resolves per-user agent directories for CLI and runtime callers. */
import { join } from "node:path";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import { resolveInstallAgentDir } from "./install-agent-dir.js";

/** Prepare one config, environment, and directory decision for a standalone SDK operation. */
export function getAgentDirResolution(agentDir?: string) {
  return resolveInstallAgentDir((env) => readCurrentConfigForResolution({ env }), { agentDir });
}

/** Standalone SDK default; configured sessions pass their resolved agentDir. */
export function getAgentDir(): string {
  return getAgentDirResolution().directory.dir;
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string | undefined {
  const directory = getAgentDirResolution().optionalDirectory;
  return directory ? join(directory.dir, "bin") : undefined;
}
