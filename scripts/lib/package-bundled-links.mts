import fs from "node:fs/promises";
import path from "node:path";
import { list as listTar } from "tar";
import { collectNpmPackInventory } from "./npm-pack-inventory.mts";
import { listBundleDependencies } from "./package-bundled-dependencies.mts";
import { isRecord } from "./record-shared.mjs";

export async function hasMissingBundledDependencies(tarballPath: string): Promise<boolean> {
  const entries = new Set<string>();
  const manifest: Buffer[] = [];
  await listTar({
    file: tarballPath,
    onReadEntry(entry) {
      entries.add(entry.path);
      if (entry.path === "package/package.json") {
        entry.on("data", (chunk: Buffer) => {
          manifest.push(chunk);
        });
      }
      entry.resume();
    },
  });
  return listBundleDependencies(JSON.parse(Buffer.concat(manifest).toString("utf8"))).some(
    (name) => !entries.has(`package/node_modules/${name}/package.json`),
  );
}

async function directory(target: string) {
  await fs.mkdir(target).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "EEXIST") {
      throw error;
    }
  });
  if (!(await fs.lstat(target)).isDirectory()) {
    throw new Error(`Bundled package destination is not a directory: ${target}`);
  }
}

// pnpm pack can omit externally linked bundled dependencies. Complete only the
// private extracted archive, never replace links in the source dependency graph:
// process interruption must not leave that graph in a temporary packing state.
export async function materializeMissingBundledDependencies(
  sourceDir: string,
  packedRoot: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await fs.lstat(packedRoot)).isDirectory()) {
    throw new Error(`Bundled package destination is not a directory: ${packedRoot}`);
  }
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(packedRoot, "package.json"), "utf8"),
  );
  let changed = false;
  for (const name of new Set(listBundleDependencies(manifest))) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
      throw new Error(`Invalid bundled dependency name: ${name}`);
    }
    const modules = path.join(packedRoot, "node_modules");
    await directory(modules);
    if (name.startsWith("@")) {
      await directory(path.join(modules, name.split("/")[0]!));
    }
    const destination = path.join(modules, name);
    const existing = await fs.lstat(destination).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (existing) {
      if (!existing.isDirectory()) {
        throw new Error(`Bundled package destination is occupied: ${destination}`);
      }
      continue;
    }
    const packagePath = path.join(sourceDir, "node_modules", name);
    const original = await fs.lstat(packagePath);
    if (!original.isSymbolicLink()) {
      throw new Error(`Packed bundle is missing from a materialized source: ${packagePath}`);
    }
    const source = await fs.realpath(packagePath);
    const packageJson: unknown = JSON.parse(
      await fs.readFile(path.join(source, "package.json"), "utf8"),
    );
    // Transitive dependencies can live beside a pnpm package in the store.
    // Only closed payloads can be copied alone; AI has its own packing owner.
    if (
      !isRecord(packageJson) ||
      [packageJson.dependencies, packageJson.optionalDependencies].some(
        (dependencies) => isRecord(dependencies) && Object.keys(dependencies).length > 0,
      )
    ) {
      throw new Error(`Linked bundle requires dependency-closure staging: ${packagePath}`);
    }
    await fs.mkdir(destination);
    const owned = await fs.lstat(destination);
    try {
      for (const entry of await fs.readdir(source)) {
        await fs.cp(path.join(source, entry), path.join(destination, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: async (copiedPath) => {
            if ((await fs.lstat(copiedPath)).isSymbolicLink()) {
              throw new Error(`Linked bundle contains a nested symlink: ${copiedPath}`);
            }
            return true;
          },
        });
      }
      // Inventory temporarily strips lifecycle scripts. Run it only on our copy,
      // never on the linked source or shared store, including on interruption.
      const { files } = collectNpmPackInventory(destination, { timeoutMs });
      const retained = new Set(files);
      for (const file of files) {
        for (
          let parent = path.posix.dirname(file);
          parent !== ".";
          parent = path.posix.dirname(parent)
        ) {
          retained.add(parent);
        }
      }
      const copied = await fs.readdir(destination, { recursive: true });
      for (const entry of copied.toSorted((left, right) => right.length - left.length)) {
        if (!retained.has(entry.split(path.sep).join("/"))) {
          await fs.rm(path.join(destination, entry), { recursive: true });
        }
      }
      const current = await fs.lstat(packagePath);
      if (current.dev !== original.dev || current.ino !== original.ino) {
        throw new Error(`Bundled package source changed while packing: ${packagePath}`);
      }
      changed = true;
    } catch (error) {
      try {
        const current = await fs.lstat(destination);
        if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isDirectory()) {
          throw new Error(`Bundled package destination changed while packing: ${destination}`, {
            cause: error,
          });
        }
        await fs.rm(destination, { recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Linked bundle staging and cleanup failed",
          {
            cause: cleanupError,
          },
        );
      }
      throw error;
    }
  }
  return changed;
}
