import fs from "node:fs/promises";
import path from "node:path";
import { isNotFoundPathError, pathScope } from "../sdk-security-runtime.js";

async function findExistingAncestor(dirPath: string): Promise<{
  ancestorDir: string;
  relativeDir: string;
}> {
  let current = path.resolve(dirPath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Invalid path: output directory must be a real directory");
      }
      return {
        ancestorDir: current,
        relativeDir: missingSegments.length === 0 ? "." : path.join(...missingSegments.reverse()),
      };
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      const parentDir = path.dirname(current);
      if (parentDir === current) {
        throw error;
      }
      missingSegments.push(path.basename(current));
      current = parentDir;
    }
  }
}

export async function ensureOutputDirectory(dirPath: string): Promise<void> {
  const resolvedDir = path.resolve(dirPath);
  const { ancestorDir, relativeDir } = await findExistingAncestor(resolvedDir);
  if (relativeDir === ".") {
    return;
  }
  const result = await pathScope(ancestorDir, { label: "output directory" }).ensureDir(relativeDir);
  if (!result.ok) {
    throw new Error(result.error);
  }
}
