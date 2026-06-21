// Qa Matrix plugin module implements cli paths behavior.
import path from "node:path";
import { assertNoSymlinkParents, pathScope } from "openclaw/plugin-sdk/security-runtime";

export function resolveRepoRelativeOutputDir(repoRoot: string, outputDir?: string) {
  if (!outputDir) {
    return undefined;
  }
  if (path.isAbsolute(outputDir)) {
    throw new Error("--output-dir must be a relative path inside the repo root.");
  }
  const resolved = path.resolve(repoRoot, outputDir);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-dir must stay within the repo root.");
  }
  return resolved;
}

function assertRepoRelativePath(repoRoot: string, targetPath: string, label: string) {
  const relative = path.relative(repoRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within the repo root.`);
  }
}

export async function ensureRepoBoundDirectory(repoRoot: string, targetDir: string, label: string) {
  const repoRootResolved = path.resolve(repoRoot);
  const targetResolved = path.resolve(targetDir);
  assertRepoRelativePath(repoRootResolved, targetResolved, label);
  try {
    await assertNoSymlinkParents({
      rootDir: repoRootResolved,
      targetPath: targetResolved,
      messagePrefix: label,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("symlink")) {
      throw new Error(`${label} must not traverse symlinks.`, { cause: error });
    }
    throw error;
  }
  const result = await pathScope(repoRootResolved, { label }).ensureDir(targetResolved);
  if (!result.ok) {
    throw new Error(`${label} must stay within the repo root.`);
  }
  return result.path;
}
