import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPathWithExistingParent } from "./sqlite-reliability-worker-paths.js";

type RestoreCrashPoint = "after-publish" | "before-publish";

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function parseCrashPoint(value: string | undefined): RestoreCrashPoint {
  if (value === "after-publish" || value === "before-publish") {
    return value;
  }
  throw new Error(`invalid SQLite restore crash point: ${String(value)}`);
}

function holdAtCrashPoint(crashPoint: RestoreCrashPoint): never {
  process.send?.({ crashPoint, kind: "crash-point" });
  while (true) {
    Atomics.wait(SLEEP_BUFFER, 0, 0, 60_000);
  }
}

async function main(argv: string[]): Promise<void> {
  const [crashPointValue, repositoryPath, validationRootPath, snapshotPath, targetPath, ...extra] =
    argv;
  if (extra.length > 0 || !repositoryPath || !validationRootPath || !snapshotPath || !targetPath) {
    throw new Error("invalid SQLite restore interruption worker arguments");
  }
  const crashPoint = parseCrashPoint(crashPointValue);
  const resolvedTargetPath = canonicalPathWithExistingParent(targetPath);

  if (crashPoint === "before-publish") {
    const originalOpen = fs.open.bind(fs);
    Object.defineProperty(fs, "open", {
      configurable: true,
      enumerable: true,
      value: async (...args: Parameters<typeof fs.open>) => {
        const [sourcePath, flags] = args;
        const resolvedSourcePath = typeof sourcePath === "string" ? path.resolve(sourcePath) : "";
        // Both native and JS publication pin the fully verified staging file
        // with numeric read flags before creating the target.
        if (
          typeof flags === "number" &&
          path.basename(resolvedSourcePath) === "database.sqlite" &&
          path.basename(path.dirname(resolvedSourcePath)).startsWith(".sqlite-publish-") &&
          canonicalPathWithExistingParent(path.dirname(path.dirname(resolvedSourcePath))) ===
            path.dirname(resolvedTargetPath)
        ) {
          holdAtCrashPoint(crashPoint);
        }
        return await originalOpen(...args);
      },
      writable: true,
    });
  } else {
    const originalRmdir = fs.rmdir.bind(fs);
    const restoreParentPath = path.dirname(resolvedTargetPath);
    Object.defineProperty(fs, "rmdir", {
      configurable: true,
      enumerable: true,
      value: async (directoryPath: string) => {
        const resolvedDirectoryPath = canonicalPathWithExistingParent(directoryPath);
        if (
          path.dirname(resolvedDirectoryPath) === restoreParentPath &&
          path.basename(resolvedDirectoryPath).startsWith(".tmp-restore-")
        ) {
          holdAtCrashPoint(crashPoint);
        }
        await originalRmdir(directoryPath);
      },
      writable: true,
    });
  }

  const { createLocalSqliteSnapshotProvider } =
    await import("../../src/snapshot/local-repository.js");
  const provider = createLocalSqliteSnapshotProvider({
    repositoryPath,
    validationRootPath,
  });
  process.send?.({ kind: "ready" });
  await provider.restoreFresh({ path: snapshotPath }, resolvedTargetPath);
  throw new Error(`SQLite restore worker passed ${crashPoint} without being terminated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
