import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS = ["hooks", "git-hooks", ".git"] as const;

function createExcludeMatcher(excludeDirs?: readonly string[]) {
  const excluded = new Set((excludeDirs ?? []).map((d) => d.toLowerCase()));
  return (name: string) => excluded.has(name.toLowerCase());
}

async function copyTreeWithoutSymlinks(params: {
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  const stats = await fs.lstat(params.sourcePath);
  // Mirror sync only carries regular files and directories across the
  // host/sandbox boundary. Symlinks and special files are dropped.
  if (stats.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    await fs.mkdir(params.targetPath, { recursive: true });
    const entries = await fs.readdir(params.sourcePath);
    await Promise.all(
      entries.map(async (entry) => {
        await copyTreeWithoutSymlinks({
          sourcePath: path.join(params.sourcePath, entry),
          targetPath: path.join(params.targetPath, entry),
        });
      }),
    );
    return;
  }
  if (stats.isFile()) {
    await fs.mkdir(path.dirname(params.targetPath), { recursive: true });
    await fs.copyFile(params.sourcePath, params.targetPath);
  }
}

export async function replaceDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from sync (preserved in target, skipped from source). */
  excludeDirs?: readonly string[];
}): Promise<void> {
  const isExcluded = createExcludeMatcher(params.excludeDirs);
  await fs.mkdir(params.targetDir, { recursive: true });
  const existing = await fs.readdir(params.targetDir);
  await Promise.all(
    existing
      .filter((entry) => !isExcluded(entry))
      .map((entry) =>
        fs.rm(path.join(params.targetDir, entry), {
          recursive: true,
          force: true,
        }),
      ),
  );
  const sourceEntries = await fs.readdir(params.sourceDir);
  for (const entry of sourceEntries) {
    if (isExcluded(entry)) {
      continue;
    }
    await copyTreeWithoutSymlinks({
      sourcePath: path.join(params.sourceDir, entry),
      targetPath: path.join(params.targetDir, entry),
    });
  }
}

export async function stageDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from the staged upload. */
  excludeDirs?: readonly string[];
}): Promise<void> {
  const isExcluded = createExcludeMatcher(params.excludeDirs);
  await fs.mkdir(params.targetDir, { recursive: true });
  const sourceEntries = await fs.readdir(params.sourceDir);
  for (const entry of sourceEntries) {
    if (isExcluded(entry)) {
      continue;
    }
    await copyTreeWithoutSymlinks({
      sourcePath: path.join(params.sourceDir, entry),
      targetPath: path.join(params.targetDir, entry),
    });
  }
}

export async function movePathWithCopyFallback(params: {
  from: string;
  to: string;
}): Promise<void> {
  try {
    await fs.rename(params.from, params.to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EXDEV") {
      throw error;
    }
  }
  await fs.cp(params.from, params.to, {
    recursive: true,
    force: true,
    dereference: false,
  });
  await fs.rm(params.from, { recursive: true, force: true });
}
