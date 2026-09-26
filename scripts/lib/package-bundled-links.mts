import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listBundleDependencies } from "./package-bundled-dependencies.mts";
import { isRecord } from "./record-shared.mjs";

async function assertIdentity(file: string, expected: Stats) {
  const actual = await fs.lstat(file);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Bundled package path changed; preserve recovery files: ${file}`);
  }
}

async function materializeLinkedBundle(packagePath: string) {
  const original = await fs.lstat(packagePath);
  if (!original.isSymbolicLink()) {
    return async () => {};
  }
  const source = await fs.realpath(packagePath);
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  );
  // A pnpm package's transitive dependencies can live beside it in the store.
  // Copying just its root is correct only for a closed payload, such as the
  // patched MCP bundle. AI's dependency alignment/materialization has its own owner.
  if (
    !isRecord(manifest) ||
    [manifest.dependencies, manifest.optionalDependencies].some(
      (dependencies) => isRecord(dependencies) && Object.keys(dependencies).length > 0,
    )
  ) {
    throw new Error(`Linked bundle requires dependency-closure staging: ${packagePath}`);
  }
  const scratch = await fs.mkdtemp(path.join(path.dirname(packagePath), ".openclaw-bundle-"));
  const scratchIdentity = await fs.lstat(scratch);
  const backup = path.join(scratch, "original");
  const staged = path.join(scratch, "package");
  let moved = false;
  let installed: Stats | undefined;
  const restore = async () => {
    if (moved) {
      await assertIdentity(backup, original);
      if (installed) {
        await assertIdentity(packagePath, installed);
        await fs.rm(packagePath, { recursive: true });
      } else {
        try {
          await fs.lstat(packagePath);
          throw new Error(`Bundled package destination is occupied: ${packagePath}`);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") {
            throw error;
          }
        }
      }
      await fs.rename(backup, packagePath);
    }
    await assertIdentity(scratch, scratchIdentity);
    await fs.rm(scratch, { recursive: true });
  };
  try {
    await fs.cp(source, staged, {
      recursive: true,
      // Do not follow unbounded links into the shared graph or other stores.
      filter: async (entry) => {
        if ((await fs.lstat(entry)).isSymbolicLink()) {
          throw new Error(`Linked bundle contains a nested symlink: ${entry}`);
        }
        return true;
      },
    });
    await assertIdentity(packagePath, original);
    await fs.rename(packagePath, backup);
    moved = true;
    const stagedIdentity = await fs.lstat(staged);
    await fs.rename(staged, packagePath);
    installed = stagedIdentity;
    return restore;
  } catch (error) {
    try {
      await restore();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Bundle staging and restoration failed.");
    }
    throw error;
  }
}

// Called under the package lifecycle lock, after workspace bundles are prepared.
// pnpm pack omits externally linked bundled dependencies even with a hoisted linker.
export async function withMaterializedBundledDependencies<T>(
  sourceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(sourceDir, "package.json"), "utf8"),
  );
  const restore: Array<() => Promise<void>> = [];
  let operationError: unknown;
  try {
    for (const name of new Set(listBundleDependencies(manifest))) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
        throw new Error(`Invalid bundled dependency name: ${name}`);
      }
      restore.push(await materializeLinkedBundle(path.join(sourceDir, "node_modules", name)));
    }
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const cleanup of restore.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      // oxlint-disable-next-line eslint/no-unsafe-finally -- Retain both operation and cleanup failures.
      throw new AggregateError(
        operationError === undefined ? errors : [operationError, ...errors],
        "Bundled package operation and restoration failed.",
      );
    }
  }
}
