import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginDoctorMigrationBackupResource } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveMatrixStateLayoutChildDepth } from "../storage-paths.js";

export async function collectLegacyMatrixStateRoots(
  stateDir: string,
  filename: string,
  options?: { includeMatrixRoot?: boolean },
): Promise<string[]> {
  const matrixRoot = path.join(stateDir, "matrix");
  const roots: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const isStorageRoot = depth === 0 || depth === 2 || depth === 4;
      if (isStorageRoot && entry.isFile() && entry.name === filename) {
        roots.push(dir);
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      // Only enter owned layout containers; archived and arbitrary descendants
      // must never become migration roots just because they contain a known file.
      const childDepth = resolveMatrixStateLayoutChildDepth(depth, entry.name);
      if (childDepth !== null) {
        await visit(entryPath, childDepth);
      }
    }
  }
  await visit(matrixRoot, 0);
  return roots
    .filter((root) => options?.includeMatrixRoot || path.resolve(root) !== path.resolve(matrixRoot))
    .toSorted();
}

export async function collectLegacyMatrixBackupResources(
  stateDir: string,
  filenames: readonly string[],
  options?: { includeMatrixRoot?: boolean },
): Promise<PluginDoctorMigrationBackupResource[]> {
  const roots = (
    await Promise.all(
      filenames.map((filename) => collectLegacyMatrixStateRoots(stateDir, filename, options)),
    )
  ).flat();
  return [...new Set(roots)].toSorted().map((root) => ({ path: root, kind: "directory" }));
}
