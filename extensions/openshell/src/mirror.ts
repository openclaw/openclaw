import fs from "node:fs/promises";
import path from "node:path";
import { lstatIfExists } from "openclaw/plugin-sdk/path-existence-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import pLimit from "p-limit";

export const DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS = ["hooks", "git-hooks", ".git"] as const;
const NESTED_GIT_EXCLUDE_DIRS = [".git"] as const;
const COPY_TREE_FS_CONCURRENCY = 16;
type PreservedEntry = "none" | "other" | "metadata";

function createExcludeMatcher(excludeDirs?: readonly string[], literalNames = false) {
  const excluded = new Set((excludeDirs ?? []).map((d) => normalizeLowercaseStringOrEmpty(d)));
  return (name: string) =>
    excluded.has(literalNames ? name.toLowerCase() : normalizeLowercaseStringOrEmpty(name));
}

const runLimitedFs = pLimit(COPY_TREE_FS_CONCURRENCY);

async function reconcileMirrorPath(params: {
  sourcePath?: string;
  targetPath: string;
  relativePath: string;
  replace: boolean;
  excludeDirs?: readonly string[];
}): Promise<PreservedEntry> {
  const targetStats = await runLimitedFs(lstatIfExists, params.targetPath, "ENOENT");
  // Preserve host entries mirror transport cannot represent and their ancestor directories.
  if (targetStats && !targetStats.isDirectory() && !targetStats.isFile()) {
    return "other";
  }
  const sourceStats = params.sourcePath ? await runLimitedFs(fs.lstat, params.sourcePath) : null;
  // Source symlinks and special files never cross the sandbox boundary.
  const sourceDir = sourceStats?.isDirectory() ? params.sourcePath : undefined;
  const sourceFile = sourceStats?.isFile() ? params.sourcePath : undefined;
  if (!params.replace && !sourceDir && !sourceFile) {
    return "none";
  }
  if (sourceDir || targetStats?.isDirectory()) {
    if (targetStats && !targetStats.isDirectory()) {
      await runLimitedFs(fs.rm, params.targetPath, { force: true });
    }
    const preservedEntries = await reconcileMirrorDirectory({
      sourceDir,
      targetDir: params.targetPath,
      relativePath: params.relativePath,
      replace: params.replace,
      excludeDirs: params.excludeDirs,
    });
    // A remote file cannot replace a directory containing preserved host entries.
    if (sourceFile && preservedEntries === "metadata") {
      throw new Error(
        `OpenShell mirror cannot replace ${JSON.stringify(params.relativePath)}: the host directory contains repository metadata; download the sandbox file directly with the OpenShell CLI before another mirrored command discards it.`,
      );
    }
    if (sourceDir || preservedEntries !== "none") {
      return preservedEntries;
    }
    await runLimitedFs(fs.rmdir, params.targetPath);
  } else if (targetStats) {
    // Unlink before copying so a host hardlink cannot redirect the new content
    // into an inode outside the workspace.
    await runLimitedFs(fs.rm, params.targetPath, { force: true });
  }
  if (sourceFile) {
    await runLimitedFs(fs.copyFile, sourceFile, params.targetPath);
  }
  return "none";
}

async function reconcileMirrorDirectory(params: {
  sourceDir?: string;
  targetDir: string;
  relativePath: string;
  replace: boolean;
  excludeDirs?: readonly string[];
}): Promise<PreservedEntry> {
  const { sourceDir } = params;
  const isExcluded = createExcludeMatcher(
    params.excludeDirs,
    params.excludeDirs === NESTED_GIT_EXCLUDE_DIRS,
  );
  const nestedExcludeDirs = isExcluded(".git") ? NESTED_GIT_EXCLUDE_DIRS : undefined;
  await runLimitedFs(fs.mkdir, params.targetDir, { recursive: true });
  const sourceEntries = new Set(sourceDir ? await runLimitedFs(() => fs.readdir(sourceDir)) : []);
  const targetEntries = params.replace
    ? await runLimitedFs(() => fs.readdir(params.targetDir))
    : [];
  // Finish every mutation before returning an error and releasing the workspace lease.
  const results = await Promise.allSettled(
    [...new Set([...sourceEntries, ...targetEntries])]
      .filter((entry) => !isExcluded(entry))
      .map((entry) =>
        reconcileMirrorPath({
          sourcePath:
            sourceDir && sourceEntries.has(entry) ? path.join(sourceDir, entry) : undefined,
          targetPath: path.join(params.targetDir, entry),
          relativePath: params.relativePath ? `${params.relativePath}/${entry}` : entry,
          replace: params.replace,
          excludeDirs: nestedExcludeDirs,
        }),
      ),
  );
  let preservedEntries: PreservedEntry = targetEntries.some(isExcluded) ? "metadata" : "none";
  const errors: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
      continue;
    }
    if (result.value === "metadata" || preservedEntries === "none") {
      preservedEntries = result.value;
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; "),
    );
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  return preservedEntries;
}

export async function replaceDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Root names to exclude; .git stays excluded at every depth when listed. */
  excludeDirs?: readonly string[];
}): Promise<void> {
  await reconcileMirrorDirectory({ ...params, relativePath: "", replace: true });
}

export async function stageDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Root names to exclude; .git stays excluded at every depth when listed. */
  excludeDirs?: readonly string[];
}): Promise<void> {
  await reconcileMirrorDirectory({ ...params, relativePath: "", replace: false });
}
