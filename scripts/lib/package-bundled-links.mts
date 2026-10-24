import fs from "node:fs/promises";
import path from "node:path";
import { list as listTar } from "tar";
import { collectNpmPackInventory } from "./npm-pack-inventory.mts";
import { listBundleDependencies } from "./package-bundle-dependencies.mts";
import {
  hasInstalledPackageAncestor,
  installedPackageDependencies,
  installedPackagePath,
  validateBundledPackageName,
} from "./package-installed-dependencies.mts";
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

async function stagePackage(
  packagePath: string,
  destination: string,
  timeoutMs: number,
  ancestors: ReadonlyMap<string, string>,
): Promise<void> {
  const original = await fs.lstat(packagePath);
  const source = await fs.realpath(packagePath);
  const packageJson: unknown = JSON.parse(
    await fs.readFile(path.join(source, "package.json"), "utf8"),
  );
  if (!isRecord(packageJson)) {
    throw new Error(`Invalid bundled package manifest: ${packagePath}`);
  }
  await fs.mkdir(destination);
  const owned = await fs.lstat(destination);
  try {
    for (const entry of await fs.readdir(source)) {
      // Installed dependencies are resolved separately; src/node_modules can be package code.
      if (entry === "node_modules") {
        continue;
      }
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
    // Inventory only our disposable copy: it temporarily strips lifecycle scripts.
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
    const staged = new Map(ancestors).set(destination, source);
    for (const dependency of await installedPackageDependencies(source, packageJson)) {
      // A cycle can use an already staged ancestor through ordinary Node resolution.
      if (hasInstalledPackageAncestor(destination, dependency, staged)) {
        continue;
      }
      const { name } = dependency;
      const modules = path.join(destination, "node_modules");
      await directory(modules);
      if (name.startsWith("@")) {
        await directory(path.join(modules, name.split("/")[0]!));
      }
      await stagePackage(dependency.path, path.join(modules, name), timeoutMs, staged);
    }
    const current = await fs.lstat(packagePath);
    if (current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error(`Bundled package source changed while packing: ${packagePath}`);
    }
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
      throw new AggregateError([error, cleanupError], "Linked bundle staging and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

// Complete only the private extracted archive. Source links and shared stores stay untouched.
export async function materializeMissingBundledDependencies(
  sourceDir: string,
  packedRoot: string,
  timeoutMs: number,
  bundleOwners: ReadonlyMap<string, string> = new Map(),
): Promise<boolean> {
  if (!(await fs.lstat(packedRoot)).isDirectory()) {
    throw new Error(`Bundled package destination is not a directory: ${packedRoot}`);
  }
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(packedRoot, "package.json"), "utf8"),
  );
  let changed = false;
  for (const name of new Set(listBundleDependencies(manifest))) {
    validateBundledPackageName(name);
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
    const owner = bundleOwners.get(name);
    if (existing) {
      if (!existing.isDirectory()) {
        throw new Error(`Bundled package destination is occupied: ${destination}`);
      }
      if (!owner) {
        continue;
      }
      // npm may have packed a same-version root copy instead of the plugin's patched bytes.
      await fs.rm(destination, { recursive: true });
    }
    const packagePath = owner
      ? await installedPackagePath(owner, name)
      : path.join(sourceDir, "node_modules", name);
    if (!packagePath) {
      throw new Error(`Bundled package is missing from its installation: ${name}`);
    }
    if (!owner && !(await fs.lstat(packagePath)).isSymbolicLink()) {
      throw new Error(`Packed bundle is missing from a materialized source: ${packagePath}`);
    }
    await stagePackage(packagePath, destination, timeoutMs, new Map());
    changed = true;
  }
  return changed;
}
