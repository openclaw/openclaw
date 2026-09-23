/**
 * Browser output directory helper.
 *
 * Creates absolute output directories while handling macOS system symlink
 * aliases such as /tmp and /var safely.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathScope, root } from "../sdk-security-runtime.js";

async function resolveSystemDirectoryAlias(dirPath: string): Promise<string> {
  // macOS exposes /tmp and /var as fixed system symlinks into /private.
  // Canonicalize only those roots before rejecting symlinks below them.
  for (const aliasRoot of ["/tmp", "/var"]) {
    if (dirPath !== aliasRoot && !dirPath.startsWith(`${aliasRoot}${path.sep}`)) {
      continue;
    }
    try {
      const stat = await fs.lstat(aliasRoot);
      if (!stat.isSymbolicLink()) {
        return dirPath;
      }
      return path.join(await fs.realpath(aliasRoot), path.relative(aliasRoot, dirPath));
    } catch {
      return dirPath;
    }
  }
  return dirPath;
}

/** Ensure an absolute browser output directory exists and is safe to use. */
export async function ensureOutputDirectory(dirPath: string): Promise<void> {
  const target = await resolveSystemDirectoryAlias(path.resolve(dirPath));
  const filesystemRoot = path.parse(target).root;
  if (target === filesystemRoot) {
    await root(filesystemRoot);
    return;
  }
  // A separator protects literal trailing whitespace from pathScope's input trimming.
  const result = await pathScope(filesystemRoot, { label: "output directory" }).ensureDir(
    `${target}${path.sep}`,
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
}
