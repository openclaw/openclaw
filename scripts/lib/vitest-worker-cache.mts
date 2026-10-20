import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyTree } from "@openclaw/fs-safe/copy";
import {
  acquireBuildArtifactLockAsync,
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  readArtifactRecord,
  resolveTsdownCompilerFiles,
  writeArtifactRecord,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "./vitest-worker-artifacts.mts";

const isCacheSlot = (directory: string) => /^run-cache-\d+$/u.test(path.basename(directory));
const MAX_GENERATIONS = 8;
const GENERATION_NAME = /^[a-f0-9]{64}$/u;

function storeLocation(root: string) {
  let common: string | undefined;
  try {
    const dotGit = path.join(root, ".git");
    const gitDir = fs.statSync(dotGit).isDirectory()
      ? dotGit
      : path.resolve(
          root,
          fs
            .readFileSync(dotGit, "utf8")
            .trim()
            .replace(/^gitdir:\s*/u, ""),
        );
    const commonFile = path.join(gitDir, "commondir");
    common = fs.realpathSync(
      fs.existsSync(commonFile)
        ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim())
        : gitDir,
    );
  } catch {
    // Isolated source fixtures need no Git administrative directory.
  }
  let store = path.join(root, ".artifacts/vitest-worker-store");
  if (common) {
    if (fs.statSync(common).dev === fs.statSync(root).dev) {
      store = path.join(common, "vitest-worker-store");
    } else {
      let volume = fs.realpathSync(root);
      while (true) {
        const parent = path.dirname(volume);
        if (parent === volume || fs.statSync(parent).dev !== fs.statSync(volume).dev) {
          break;
        }
        volume = parent;
      }
      store = path.join(volume, ".openclaw-vitest-workers", hashVitestWorkerArtifact(common));
    }
  }
  try {
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
    // A read-only shared administrative directory or volume root keeps the local fallback.
    store = path.join(root, ".artifacts/vitest-worker-store");
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  }
  return store;
}

function portableInputs(root: string, inputs: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(inputs)
      .map(([file, hash]): [string, string] => {
        const relative = path.isAbsolute(file) ? portableRelativePath(root, file) : file;
        return [relative === ".." || relative.startsWith("../") ? file : relative, hash];
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function localManifest(root: string, manifest: VitestWorkerManifest): VitestWorkerManifest {
  return {
    ...manifest,
    inputs: Object.fromEntries(
      Object.entries(manifest.inputs).map(([file, hash]) => [path.resolve(root, file), hash]),
    ),
  };
}

function inputSignature(metadata: string, inputs: Record<string, string>) {
  return hashVitestWorkerArtifact(JSON.stringify([metadata, Object.entries(inputs)]));
}

function outputInventory(
  directory: string,
  manifest: VitestWorkerManifest,
  bytes: string | Buffer,
) {
  const outputs: Record<string, string> = {};
  for (const [name, hash] of Object.entries(manifest.outputs)) {
    const relative = portableRelativePath(directory, path.resolve(directory, "dist", name));
    const first = relative.split("/")[0];
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.split("/").includes("..") ||
      first === "package.json" ||
      first === ".vitest-resource-owner" ||
      first === "manifest.json" ||
      Object.hasOwn(outputs, relative)
    ) {
      return undefined;
    }
    outputs[relative] = hash;
  }
  if (!Object.hasOwn(outputs, "dist/build-info.json")) {
    return undefined;
  }
  outputs["manifest.json"] = hashVitestWorkerArtifact(bytes);
  return outputs;
}

/** An inventory authorizes regular files and only their ancestor directories. */
async function hasExactInventory(
  root: string,
  outputs: Record<string, string>,
  allowOtherRoots: boolean,
) {
  const expected = new Set(Object.keys(outputs));
  const roots = new Set<string>();
  const directories = new Set<string>();
  for (const name of expected) {
    const parts = name.split("/");
    roots.add(parts[0]!);
    for (let count = 1; count < parts.length; count++) {
      directories.add(parts.slice(0, count).join("/"));
    }
  }
  try {
    if (!(await fs.promises.lstat(root)).isDirectory()) {
      return false;
    }
    const pending = [""];
    for (let offset = 0; offset < pending.length;) {
      const batch = pending.slice(offset, offset + 16);
      offset += batch.length;
      const completed = await Promise.allSettled(
        batch.map(async (parent) => ({
          parent,
          entries: await fs.promises.readdir(path.join(root, parent), { withFileTypes: true }),
        })),
      );
      for (const result of completed) {
        if (result.status === "rejected") {
          return false;
        }
        for (const entry of result.value.entries) {
          const name = result.value.parent ? `${result.value.parent}/${entry.name}` : entry.name;
          if (!result.value.parent && allowOtherRoots && !roots.has(name)) {
            continue;
          }
          if (entry.isDirectory() && directories.has(name)) {
            pending.push(name);
          } else if (!entry.isFile() || !expected.delete(name)) {
            return false;
          }
        }
      }
    }
    return expected.size === 0;
  } catch {
    return false;
  }
}

function matchesInventory(
  record: ArtifactRecord,
  manifest: VitestWorkerManifest,
  outputs: Record<string, string>,
) {
  return (
    manifest.cacheSignature === record.signature &&
    JSON.stringify(record.inputs) === JSON.stringify(Object.keys(manifest.inputs).toSorted()) &&
    Object.keys(outputs).length === Object.keys(record.outputs).length &&
    Object.entries(outputs).every(([name, hash]) => record.outputs[name] === hash)
  );
}

type Generation = { name: string; directory: string; used: number };
async function generations(store: string): Promise<Generation[]> {
  const entries = await fs.promises.readdir(store, { withFileTypes: true });
  const result: Generation[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && GENERATION_NAME.test(entry.name)) {
      const directory = path.join(store, entry.name);
      result.push({
        name: entry.name,
        directory,
        used: (await fs.promises.stat(directory)).mtimeMs,
      });
    }
  }
  return result.toSorted(
    (left, right) => right.used - left.used || left.name.localeCompare(right.name),
  );
}

async function readGeneration(generation: Generation) {
  const outputRoot = path.join(generation.directory, "outputs");
  try {
    const record = readArtifactRecord(path.join(generation.directory, "stamp.json"));
    if (!record || record.signature !== generation.name) {
      return undefined;
    }
    const bytes = await fs.promises.readFile(path.join(outputRoot, "manifest.json"));
    const manifest: VitestWorkerManifest = JSON.parse(bytes.toString("utf8"));
    const outputs = outputInventory(outputRoot, manifest, bytes);
    if (
      !outputs ||
      !matchesInventory(record, manifest, outputs) ||
      !(await hasExactInventory(outputRoot, outputs, false))
    ) {
      return undefined;
    }
    // The store owns immutable output bytes; source verification uses the borrower's root below.
    await verifyVitestWorkerArtifacts(outputRoot, { ...manifest, inputs: {} });
    return { manifest, outputRoot, outputs };
  } catch {
    return undefined;
  }
}

async function copyOutputs(source: string, target: string, outputs: Record<string, string>) {
  const roots = [...new Set(Object.keys(outputs).map((name) => name.split("/")[0]!))].filter(
    (name) => name !== "manifest.json",
  );
  for (const name of roots) {
    if (fs.existsSync(path.join(target, name))) {
      throw new Error(`Compiled subprocess copy target already exists: ${name}`);
    }
  }
  for (const name of roots) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    if ((await fs.promises.lstat(from)).isDirectory()) {
      // APFS uses one bulk clone. Other filesystems retain independent owned copies.
      await copyTree(from, to, { clone: "auto" });
    } else {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
    }
  }
}

async function touchGeneration(directory: string) {
  const now = new Date();
  await fs.promises.utimes(directory, now, now);
}

async function pruneGenerations(store: string) {
  for (const stale of (await generations(store)).slice(MAX_GENERATIONS)) {
    await fs.promises.rm(stale.directory, { recursive: true, force: true });
  }
  // Publication holds this same lock, so any leftover private stage belongs to a dead publisher.
  for (const entry of await fs.promises.readdir(store)) {
    if (entry.startsWith(".stage-")) {
      await fs.promises.rm(path.join(store, entry), { recursive: true, force: true });
    }
  }
}

/** Metadata preparation belongs to the compiler; joined cleanup does not load that graph. */
export async function createVitestWorkerCache(root: string, directory: string) {
  if (!isCacheSlot(directory)) {
    return undefined;
  }
  const store = storeLocation(root);
  const { CompilerInputSnapshot } = await import("./compiler-input-snapshot.mts");
  const snapshot = new CompilerInputSnapshot(root, {
    toolchainFiles: resolveTsdownCompilerFiles(),
    generatorInputs: ["package.json", "pnpm-lock.yaml"],
    isGeneratorInput: (file) => file.endsWith("/package.json"),
  });
  const args = [
    `schtasks=${process.env.CI_WINDOWS_SCHTASKS_INTEGRATION ?? ""}`,
    `node-options=${process.env.NODE_OPTIONS ?? ""}`,
    `node-arguments=${JSON.stringify(process.execArgv)}`,
    `umask=${process.umask()}`,
  ];
  let metadata: Promise<string> | undefined;
  const prepare = () =>
    (metadata ??= (async () => {
      await snapshot.prepare();
      return snapshot.environmentSignature(args);
    })());

  return {
    async restore(): Promise<VitestWorkerManifest | undefined> {
      const lock = await acquireBuildArtifactLockAsync(path.join(store, "store"));
      try {
        for (const generation of await generations(store)) {
          const retained = await readGeneration(generation);
          if (!retained) {
            continue;
          }
          const manifest = localManifest(root, retained.manifest);
          const signature = await prepare();
          let current: Record<string, string>;
          try {
            current = Object.fromEntries(
              Object.keys(retained.manifest.inputs).map((file) => [
                file,
                snapshot.hash(path.resolve(root, file)),
              ]),
            );
          } catch {
            continue;
          }
          if (inputSignature(signature, current) !== generation.name) {
            continue;
          }
          await copyOutputs(retained.outputRoot, directory, retained.outputs);
          await fs.promises.writeFile(
            path.join(directory, "manifest.json"),
            `${JSON.stringify(manifest)}\n`,
          );
          await touchGeneration(generation.directory);
          return manifest;
        }
      } finally {
        await lock.release();
      }
      await prepare();
      return undefined;
    },
    async prepareOutputs(): Promise<VitestWorkerManifest | undefined> {
      const lock = await acquireBuildArtifactLockAsync(path.join(store, "store"));
      try {
        for (const generation of await generations(store)) {
          const retained = await readGeneration(generation);
          if (retained) {
            await copyOutputs(retained.outputRoot, directory, retained.outputs);
            return localManifest(root, retained.manifest);
          }
        }
      } finally {
        await lock.release();
      }
      return undefined;
    },
    async seal(manifest: VitestWorkerManifest) {
      return inputSignature(await prepare(), portableInputs(root, manifest.inputs));
    },
  };
}

/** The compiler publishes independent snapshots before borrowers can mutate their output. */
export async function retainVitestWorkerArtifacts(
  root: string,
  directory: string,
  manifest: VitestWorkerManifest,
) {
  if (
    !isCacheSlot(directory) ||
    !manifest.cacheSignature ||
    !GENERATION_NAME.test(manifest.cacheSignature)
  ) {
    return false;
  }
  const completed: VitestWorkerManifest = {
    identity: manifest.identity,
    inputs: portableInputs(root, manifest.inputs),
    outputs: manifest.outputs,
    durationMs: manifest.durationMs,
    cacheSignature: manifest.cacheSignature,
  };
  const bytes = `${JSON.stringify(completed)}\n`;
  const outputs = outputInventory(directory, completed, bytes);
  if (!outputs || !(await hasExactInventory(directory, outputs, true))) {
    return false;
  }
  const store = storeLocation(root);
  const lock = await acquireBuildArtifactLockAsync(path.join(store, "store"));
  let temporary: string | undefined;
  try {
    await pruneGenerations(store);
    const destination = path.join(store, completed.cacheSignature!);
    const winner = await readGeneration({
      name: completed.cacheSignature!,
      directory: destination,
      used: 0,
    });
    if (winner) {
      await touchGeneration(destination);
      await pruneGenerations(store);
      return true;
    }
    await fs.promises.rm(destination, { force: true, recursive: true });
    temporary = path.join(store, `.stage-${randomUUID()}`);
    const outputRoot = path.join(temporary, "outputs");
    await fs.promises.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await copyOutputs(directory, outputRoot, outputs);
    await fs.promises.writeFile(path.join(outputRoot, "manifest.json"), bytes, { flag: "wx" });
    writeArtifactRecord(path.join(temporary, "stamp.json"), {
      version: ARTIFACT_CACHE_VERSION,
      signature: completed.cacheSignature!,
      inputs: Object.keys(completed.inputs).toSorted(),
      outputs,
    });
    await fs.promises.rename(temporary, destination);
    temporary = undefined;
    await pruneGenerations(store);
    return true;
  } finally {
    try {
      if (temporary) {
        await fs.promises.rm(temporary, { recursive: true, force: true });
      }
    } finally {
      await lock.release();
    }
  }
}
