import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  acquireBuildArtifactLockAsync,
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  readArtifactRecord,
  resolveBuildStepCacheState,
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

function cacheLocation(root: string, directory: string) {
  const cacheRoot = path.join(root, ".artifacts/vitest-worker-cache");
  fs.mkdirSync(path.join(cacheRoot, path.basename(directory)), { recursive: true, mode: 0o700 });
  const planned = resolveBuildStepCacheState(
    {
      label: path.basename(directory),
      cache: { inputs: ["package.json"], outputs: [], restore: "always" },
    },
    {
      rootDir: root,
      artifactRoot: directory,
      env: {
        ...process.env,
        BUILD_ALL_CACHE_ROOT: cacheRoot,
      },
      inputSignature: () => "",
    },
  );
  if (!planned.stampPath || !planned.outputRoot) {
    throw new Error("Compiled subprocess cache location is unavailable");
  }
  return { stampPath: planned.stampPath, outputRoot: planned.outputRoot, record: planned.record };
}

function inputSignature(metadata: string, inputs: string[], hashes: Record<string, string>) {
  return hashVitestWorkerArtifact(
    JSON.stringify([
      metadata,
      inputs.map((file) => {
        const hash = hashes[file];
        if (!hash) {
          throw new Error(`Compiler input hash unavailable: ${file}`);
        }
        return [file, hash];
      }),
    ]),
  );
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
  const inputs = Object.keys(manifest.inputs).toSorted();
  return (
    manifest.cacheSignature === record.signature &&
    JSON.stringify(record.inputs) === JSON.stringify(inputs) &&
    Object.keys(outputs).length === Object.keys(record.outputs).length &&
    Object.entries(outputs).every(([name, hash]) => record.outputs[name] === hash)
  );
}

async function transferRoots(
  source: string,
  target: string,
  outputs: Record<string, string>,
  verifyHeld: () => Promise<boolean>,
) {
  const roots = [...new Set(Object.keys(outputs).map((name) => name.split("/")[0]!))];
  for (const name of roots) {
    try {
      await fs.promises.lstat(path.join(target, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Compiled subprocess transfer target already exists: ${name}`);
  }
  for (const name of roots) {
    if (!(await verifyHeld())) {
      throw new Error("Compiled subprocess cache transfer lock changed");
    }
    await fs.promises.rename(path.join(source, name), path.join(target, name));
  }
}

/** Metadata preparation belongs to the compiler; joined cleanup does not load that graph. */
export async function createVitestWorkerCache(
  root: string,
  directory: string,
  compilerInputs: string[],
) {
  if (!isCacheSlot(directory)) {
    return undefined;
  }
  const { CompilerInputSnapshot } = await import("./compiler-input-snapshot.mts");
  const snapshot = () =>
    new CompilerInputSnapshot(root, {
      toolchainFiles: resolveTsdownCompilerFiles(),
      generatorInputs: ["package.json", "pnpm-lock.yaml", ...compilerInputs],
      isGeneratorInput: (file) => file.endsWith("/package.json"),
    });
  // These absolute external URLs must return to the same exclusively reserved slot.
  const args = [
    `output=${fs.realpathSync(directory)}`,
    `schtasks=${process.env.CI_WINDOWS_SCHTASKS_INTEGRATION ?? ""}`,
    `node-options=${process.env.NODE_OPTIONS ?? ""}`,
    `node-arguments=${JSON.stringify(process.execArgv)}`,
    `umask=${process.umask()}`,
  ];
  const before = snapshot();
  let startedAt: number;
  let metadata: Promise<string> | undefined;
  const prepareBefore = () =>
    (metadata ??= (async () => {
      await before.prepare();
      const signature = before.signature("tsconfig.json", args, []);
      startedAt = Date.now();
      return signature;
    })());

  async function restoreGeneration(): Promise<VitestWorkerManifest | undefined> {
    const location = cacheLocation(root, directory);
    const lock = await acquireBuildArtifactLockAsync(location.stampPath);
    try {
      const record = readArtifactRecord(location.stampPath);
      if (!record?.inputs || JSON.stringify(record) !== JSON.stringify(location.record)) {
        return undefined;
      }
      let manifest: VitestWorkerManifest;
      let outputs: Record<string, string>;
      try {
        const bytes = await fs.promises.readFile(path.join(location.outputRoot, "manifest.json"));
        manifest = JSON.parse(bytes.toString("utf8"));
        const inventory = outputInventory(directory, manifest, bytes);
        if (
          !inventory ||
          !matchesInventory(record, manifest, inventory) ||
          !(await hasExactInventory(location.outputRoot, inventory, false))
        ) {
          return undefined;
        }
        await verifyVitestWorkerArtifacts(location.outputRoot, manifest);
        outputs = inventory;
      } catch {
        return undefined;
      }
      // No compiler runs on a hit. Observe resolution after the byte reads,
      // immediately before transfer, rather than scanning the namespace twice.
      const signature = await prepareBefore();
      if (inputSignature(signature, record.inputs, manifest.inputs) !== record.signature) {
        return undefined;
      }
      if (!(await lock.verifyStillHeld())) {
        throw new Error("Compiled subprocess cache restoration lock changed");
      }
      if (JSON.stringify(readArtifactRecord(location.stampPath)) !== JSON.stringify(record)) {
        return undefined;
      }
      await fs.promises.rm(location.stampPath, { force: true });
      await transferRoots(location.outputRoot, directory, outputs, () => lock.verifyStillHeld());
      await fs.promises.rmdir(location.outputRoot);
      return manifest;
    } finally {
      await lock.release();
    }
  }

  return {
    get startedAt() {
      return startedAt;
    },
    async restore(): Promise<VitestWorkerManifest | undefined> {
      const restored = await restoreGeneration();
      // A miss still captures the complete pre-compilation snapshot for sealing.
      await prepareBefore();
      return restored;
    },
    async seal(manifest: VitestWorkerManifest) {
      const after = snapshot();
      await after.prepare();
      const sealed = after.seal("tsconfig.json", args, [], before, startedAt);
      return inputSignature(
        sealed.signature,
        Object.keys(manifest.inputs).toSorted(),
        manifest.inputs,
      );
    },
  };
}

/** Only the run owner may retain artifacts after every borrower and resource has joined. */
export async function retainVitestWorkerArtifacts(
  root: string,
  directory: string,
  manifest: VitestWorkerManifest,
) {
  if (!isCacheSlot(directory) || !manifest.cacheSignature) {
    return false;
  }
  const completed: VitestWorkerManifest = {
    identity: manifest.identity,
    inputs: manifest.inputs,
    outputs: manifest.outputs,
    durationMs: manifest.durationMs,
    cacheSignature: manifest.cacheSignature,
  };
  const bytes = `${JSON.stringify(completed)}\n`;
  const outputs = outputInventory(directory, completed, bytes);
  if (!outputs || !(await hasExactInventory(directory, outputs, true))) {
    return false;
  }
  // Rebuild the manifest from the owner's captured facts, never runtime-written metadata.
  const temporary = path.join(directory, `.manifest-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: "wx" });
    await fs.promises.rename(temporary, path.join(directory, "manifest.json"));
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  const location = cacheLocation(root, directory);
  const lock = await acquireBuildArtifactLockAsync(location.stampPath);
  try {
    if (!(await lock.verifyStillHeld())) {
      throw new Error("Compiled subprocess cache retention lock changed");
    }
    await fs.promises.rm(location.stampPath, { force: true });
    if (!(await lock.verifyStillHeld())) {
      throw new Error("Compiled subprocess cache retention lock changed");
    }
    await fs.promises.rm(location.outputRoot, { force: true, recursive: true });
    if (!(await lock.verifyStillHeld())) {
      throw new Error("Compiled subprocess cache retention lock changed");
    }
    await fs.promises.mkdir(location.outputRoot, { recursive: true, mode: 0o700 });
    if (!(await lock.verifyStillHeld())) {
      throw new Error("Compiled subprocess cache retention lock changed");
    }
    await transferRoots(directory, location.outputRoot, outputs, () => lock.verifyStillHeld());
    if (!(await lock.verifyStillHeld())) {
      throw new Error("Compiled subprocess cache retention lock changed");
    }
    writeArtifactRecord(location.stampPath, {
      version: ARTIFACT_CACHE_VERSION,
      signature: completed.cacheSignature!,
      inputs: Object.keys(completed.inputs).toSorted(),
      outputs,
    });
    return true;
  } finally {
    await lock.release();
  }
}
