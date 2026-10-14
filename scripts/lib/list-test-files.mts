// Lists tracked test files with a filesystem fallback for non-git contexts.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Repository inventories exceed Node's 1 MiB subprocess default; keep Git authoritative.
export const GIT_LS_FILES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** List git-tracked test files below a root, falling back to recursive filesystem discovery. */
export function listTrackedTestFiles(rootDir: string, suffix?: string): string[] {
  const matches = (file: string) =>
    suffix
      ? file.endsWith(suffix)
      : file.endsWith(".test.ts") ||
        (file.endsWith(".test.tsx") &&
          /(?:^|\/)(?:ui\/src\/|extensions\/[^/]+\/browser\/)/u.test(file));
  const result = spawnSync("git", ["ls-files", "--", rootDir], {
    encoding: "utf8",
    maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter(matches)
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
      if (entry.isFile() && matches(path.replaceAll("\\", "/"))) {
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
  return !unitFastFiles.has(file) && !/\.(?:e2e|live)\.test\.tsx?$/u.test(file);
}
