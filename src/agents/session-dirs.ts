import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "../infra/errno.js";

function mapAgentSessionDirs(
  agentsDir: string,
  entries: Dirent[],
  includeDirName?: (dirName: string) => boolean,
): string[] {
  return entries
    .filter((entry) => entry.isDirectory() && (includeDirName?.(entry.name) ?? true))
    .map((entry) => path.join(agentsDir, entry.name, "sessions"))
    .toSorted((a, b) => a.localeCompare(b));
}

export function resolveAgentSessionDirsFromAgentsDirSync(
  agentsDir: string,
  includeDirName?: (dirName: string) => boolean,
): string[] {
  let entries: Dirent[];
  try {
    entries = fsSync.readdirSync(agentsDir, { withFileTypes: true });
  } catch (err) {
    return ignoreMissingPath(err) ?? [];
  }

  return mapAgentSessionDirs(agentsDir, entries, includeDirName);
}

export async function resolveAgentSessionDirs(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  const entries = await fs.readdir(agentsDir, { withFileTypes: true }).catch(ignoreMissingPath);
  return mapAgentSessionDirs(agentsDir, entries ?? []);
}
