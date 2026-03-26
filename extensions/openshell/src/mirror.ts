import fs from "node:fs/promises";
import path from "node:path";

export async function replaceDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from sync (preserved in target, skipped from source). */
  excludeDirs?: string[];
}): Promise<void> {
  // Case-insensitive matching: on macOS/Windows the filesystem is typically
  // case-insensitive, so "Hooks" would resolve to the same directory as "hooks".
  const excluded = new Set((params.excludeDirs ?? []).map((d) => d.toLowerCase()));
  const isExcluded = (name: string) => excluded.has(name.toLowerCase());
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
    await fs.cp(path.join(params.sourceDir, entry), path.join(params.targetDir, entry), {
      recursive: true,
      force: true,
      dereference: false,
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
