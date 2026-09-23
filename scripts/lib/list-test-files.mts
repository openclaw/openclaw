// Lists tracked test files with a filesystem fallback for non-git contexts.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/** List git-tracked test files below a root, falling back to recursive filesystem discovery. */
export function listTrackedTestFiles(rootDir: string, suffix = ".test.ts"): string[] {
  // Filter before capture so non-test paths cannot overflow Git's output buffer.
  const suffixPattern = suffix.replace(/[*?[\]\\]/gu, "\\$&");
  const pathspec = `${join(rootDir, "*").split(sep).join("/")}${suffixPattern}`;
  const result = spawnSync("git", ["ls-files", "--", pathspec], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const spawnError: NodeJS.ErrnoException | undefined = result.error;
  if (spawnError && spawnError.code !== "ENOENT") {
    throw spawnError;
  }
  if (result.status === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter((line) => line.endsWith(suffix))
      .toSorted((a, b) => a.localeCompare(b));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
}

export function isStripeEligibleTestFile(
  file: string,
  unitFastFiles: ReadonlySet<string>,
): boolean {
  return (
    !unitFastFiles.has(file) && !file.endsWith(".e2e.test.ts") && !file.endsWith(".live.test.ts")
  );
}
