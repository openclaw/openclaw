import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_CACHE_VERSION,
  portableRelativePath,
  listCacheFiles,
  type ArtifactRecord,
} from "./build-artifact-cache.mts";
import { readNativeTypeScriptConfig } from "./native-typescript-config.mts";

type CompilerInputPolicy = {
  toolchainFiles: string[];
  generatorInputs: string[];
  isGeneratorInput?: (file: string) => boolean;
  assertInput?: (file: string) => string;
};
type TopologyEntry = { id: string; name: string; directory: string; file?: string };
type NamespaceDirectory = { directory: string; realDirectory: string; installed: boolean };
type CapturedInput = { bytes: Buffer; hash: string; ctimeMs: number; dev: number; ino: number };
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const PREPARATION_CONCURRENCY = 16;

function diagnosticJson(value: object) {
  // JSON escapes C0 controls but leaves terminal controls and bidi formatting literal.
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function namespaceEntries(
  entries: TopologyEntry[],
  outputRoot?: string,
  producedFiles?: ReadonlySet<string>,
  previousEntries?: TopologyEntry[],
) {
  const previousIds = previousEntries && new Set(previousEntries.map(({ id }) => id));
  return entries.filter(
    ({ id, name, directory, file }) =>
      (!outputRoot ||
        (directory !== outputRoot && !directory.startsWith(`${outputRoot}${path.sep}`))) &&
      !(
        previousIds &&
        !previousIds.has(id) &&
        name === id &&
        file !== undefined &&
        producedFiles?.has(file)
      ),
  );
}

function skipNamespaceEntry(id: string, name: string, installed: boolean) {
  return (
    id === ".ci-harness" ||
    id === ".worktrees" ||
    // Tests create and remove fixture packages here while sibling compilers run.
    // Only checkout-root scratch is excluded; workspace and installed inputs still count.
    id === ".tmp" ||
    id === ".cache/openclaw-pnpm-store" ||
    id === ".cache/vitest" ||
    id === "apps/macos/.build" ||
    id === "apps/macos/.build-local" ||
    id === "apps/macos-mlx-tts/.build" ||
    (!installed && [".git", ".artifacts", ".claude", ".agents", ".local", "dist"].includes(name)) ||
    // Installed tool scratch is not resolvable; pnpm's package store is.
    (installed && name !== ".pnpm" && name.startsWith(".")) ||
    /^extensions\/[^/]+\/(?:__rootdir_boundary_canary__\.ts|tsconfig\.rootdir-canary\.json)$/u.test(
      id,
    )
  );
}

function prepareNamespace(rootDir: string) {
  type Result = { entries: fs.Dirent[] } | { error: unknown };
  type Directory = {
    path: string;
    contexts: Map<string, NamespaceDirectory>;
    completion: Promise<Result>;
    complete: (result: Result) => void;
    result?: Result;
  };
  const directories = new Map<string, Directory>();
  const pending = new Map<string, Directory>();
  const demanded: Directory[] = [];
  const active = new Set<Promise<void>>();
  let closed = false;

  function expand(context: NamespaceDirectory, entries: fs.Dirent[]) {
    for (const entry of entries) {
      const directory = path.join(context.directory, entry.name);
      if (
        entry.isDirectory() &&
        !skipNamespaceEntry(portableRelativePath(rootDir, directory), entry.name, context.installed)
      ) {
        void enqueue({
          directory,
          realDirectory: path.join(context.realDirectory, entry.name),
          installed: context.installed || entry.name === "node_modules",
        });
      }
    }
  }

  function enqueue(context: NamespaceDirectory, priority = false) {
    let directory = directories.get(context.realDirectory);
    if (!directory) {
      let complete!: (result: Result) => void;
      const completion = new Promise<Result>((resolve) => {
        complete = resolve;
      });
      directory = {
        path: context.realDirectory,
        contexts: new Map(),
        completion,
        complete,
      };
      directories.set(directory.path, directory);
      pending.set(directory.path, directory);
    }
    const key = `${context.directory}\0${context.installed}`;
    if (!directory.contexts.has(key)) {
      directory.contexts.set(key, context);
      if (directory.result && "entries" in directory.result) {
        expand(context, directory.result.entries);
      }
    }
    if (priority && pending.delete(directory.path)) {
      demanded.push(directory);
    }
    return directory.completion;
  }

  function pump() {
    if (closed) {
      return;
    }
    while (active.size < PREPARATION_CONCURRENCY) {
      const directory = demanded.shift() ?? pending.values().next().value;
      if (!directory) {
        break;
      }
      pending.delete(directory.path);
      const reading: Promise<void> = fs.promises
        .readdir(directory.path, { withFileTypes: true })
        .then(
          (entries): Result => ({ entries }),
          (error: unknown): Result => ({ error }),
        )
        .then((result) => {
          directory.result = result;
          if (!closed && "entries" in result) {
            for (const context of directory.contexts.values()) {
              expand(context, result.entries);
            }
          }
          // Speculative errors matter only if the ordered visitor admits this path.
          directory.complete(result);
        })
        .finally(() => {
          active.delete(reading);
          pump();
        });
      active.add(reading);
    }
  }

  return {
    async read(context: NamespaceDirectory) {
      const result = enqueue(context, true);
      pump();
      const completed = await result;
      if ("error" in completed) {
        throw completed.error;
      }
      return completed.entries;
    },
    async close() {
      closed = true;
      pending.clear();
      demanded.length = 0;
      await Promise.allSettled(active);
    },
  };
}

async function prepareBatches<T>(values: T[], prepare: (value: T) => Promise<unknown>) {
  for (let offset = 0; offset < values.length; offset += PREPARATION_CONCURRENCY) {
    const completed = await Promise.allSettled(
      values.slice(offset, offset + PREPARATION_CONCURRENCY).map(prepare),
    );
    const failed = completed.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
  }
}

/** One phase owns all byte reads; freshness never trusts persisted timestamps. */
export class CompilerInputSnapshot {
  private readonly files = new Map<string, CapturedInput>();
  private sealedInputs?: ReadonlyMap<string, CapturedInput>;
  private readonly configs = new Map<
    string,
    { files: string[]; roots: string[]; options: Record<string, unknown> }
  >();
  private topology?: TopologyEntry[];
  private readonly namespaceDigests = new Map<string | undefined, string>();
  private generatorInputs?: string[];
  private readonly policy: CompilerInputPolicy;
  private tools?: string;
  readonly rootDir: string;
  constructor(rootDir: string, policy: CompilerInputPolicy) {
    this.rootDir = rootDir;
    this.policy = policy;
  }

  private inputPath(file: string) {
    const absolute = path.resolve(this.rootDir, file);
    return this.policy.assertInput?.(absolute) ?? absolute;
  }

  private read(file: string) {
    // Admit the same spelling used for reads and prior-snapshot keys, including Windows aliases.
    const absolute = this.inputPath(file);
    let entry = this.files.get(absolute);
    if (!entry) {
      const before = fs.statSync(absolute);
      const bytes = fs.readFileSync(absolute);
      const after = fs.statSync(absolute);
      entry = this.capture(absolute, before, bytes, after);
    }
    return entry;
  }

  private capture(file: string, before: fs.Stats, bytes: Buffer, after: fs.Stats) {
    if (
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    ) {
      throw new Error(`Boundary input changed while reading: ${file}`);
    }
    const entry = {
      bytes,
      hash: digest(bytes),
      ctimeMs: after.ctimeMs,
      dev: after.dev,
      ino: after.ino,
    };
    this.files.set(file, entry);
    return entry;
  }

  /** Prefetch I/O while the shared ordered visitor retains namespace ownership. */
  async prepare() {
    if (this.topology === undefined) {
      const directories = prepareNamespace(this.rootDir);
      const traversal = this.readTopology();
      try {
        let next = traversal.next();
        while (!next.done) {
          next = traversal.next(await directories.read(next.value));
        }
        this.topology = next.value;
      } finally {
        await directories.close();
      }
    }
    await prepareBatches(
      [...new Set(this.toolInputs().map((file) => this.inputPath(file)))],
      async (file) => {
        if (!this.files.has(file)) {
          const before = await fs.promises.stat(file);
          const bytes = await fs.promises.readFile(file);
          const after = await fs.promises.stat(file);
          this.capture(file, before, bytes, after);
        }
      },
    );
  }

  hash = (file: string) => this.read(file).hash;

  private config(file: string) {
    let result = this.configs.get(file);
    if (!result) {
      try {
        const parsed = readNativeTypeScriptConfig({
          cwd: this.rootDir,
          configFileName: this.inputPath(file),
          readFile: (name) => this.read(name).bytes.toString("utf8"),
        });
        result = {
          files: parsed.configFiles,
          roots: parsed.fileNames.toSorted(),
          options: parsed.options,
        };
      } catch (error) {
        throw new Error(`Invalid boundary config ${file}: ${String(error)}`, { cause: error });
      }
      this.configs.set(file, result);
    }
    return result;
  }

  private *readTopology(): Generator<NamespaceDirectory, TopologyEntry[], fs.Dirent[]> {
    const rootDir = this.rootDir;
    const names: TopologyEntry[] = [];
    const visited = new Map<string, boolean>();
    const active = new Set<string>();
    const visit = function* (
      directory: string,
      realDirectory: string,
      installed = false,
    ): Generator<NamespaceDirectory, void, fs.Dirent[]> {
      if (
        active.has(realDirectory) ||
        visited.get(realDirectory) === true ||
        (!installed && visited.has(realDirectory))
      ) {
        return;
      }
      // A local alias may precede an installed package, whose dist must count.
      // Upgrade that traversal once; active ancestors still fence link cycles.
      visited.set(realDirectory, installed);
      active.add(realDirectory);
      const entries = (yield { directory, realDirectory, installed }).toSorted((left, right) =>
        left.name < right.name ? -1 : 1,
      );
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const canonicalFile = path.join(realDirectory, entry.name);
        const id = portableRelativePath(rootDir, file);
        const add = (name: string, contentFile?: string) =>
          names.push({ id, name, directory: realDirectory, file: contentFile });
        if (skipNamespaceEntry(id, entry.name, installed)) {
          continue;
        }
        let canonical = canonicalFile;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          // Resolve entries beneath the parent we enumerated. Windows relative
          // links reached through a junction can otherwise follow a different alias.
          add(`${id}->${fs.readlinkSync(canonicalFile)}`);
          try {
            isDirectory = fs.statSync(canonicalFile).isDirectory();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            add(`${id}:missing`);
            continue;
          }
          add(`${id}:${isDirectory ? "directory" : "file"}`);
          // The first link's text can stay unchanged while a later link retargets.
          canonical = fs.realpathSync.native(canonicalFile);
          const relativeTarget = portableRelativePath(rootDir, canonical);
          const target =
            relativeTarget === ".." ||
            relativeTarget.startsWith("../") ||
            path.isAbsolute(relativeTarget)
              ? canonical
              : relativeTarget;
          add(`${id}:target:${target}`);
        }
        if (isDirectory) {
          // Native declaration module naming can resolve an empty package
          // directory. Its presence is a dependency lookup fact even without files.
          if (
            !entry.isSymbolicLink() &&
            !entry.name.startsWith(".") &&
            (path.basename(directory) === "node_modules" ||
              (path.basename(directory).startsWith("@") &&
                path.basename(path.dirname(directory)) === "node_modules"))
          ) {
            add(`${id}:directory`);
          }
          // Extend native-canonical parents; resolve only links so Windows aliases
          // share output ownership without rewalking every ancestor.
          yield* visit(file, canonical, installed || entry.name === "node_modules");
        } else if (/\.(?:[cm]?[jt]sx?|json)$/u.test(entry.name)) {
          add(id, canonicalFile);
        }
      }
      active.delete(realDirectory);
    };
    // A failed lookup can be outside declared roots. Name/existence changes in
    // the local resolution namespace invalidate conservatively; unrelated byte
    // edits do not. Installed package contents are included, not just lockfiles.
    yield* visit(rootDir, fs.realpathSync.native(rootDir));
    // An ancestor install can change fallback resolution without a checkout edit.
    // Capture its existence only; external packages are never snapshot byte inputs.
    let ancestor = path.dirname(path.resolve(rootDir));
    while (true) {
      const install = path.join(ancestor, "node_modules");
      if (fs.statSync(install, { throwIfNoEntry: false })?.isDirectory()) {
        names.push({ id: install, name: `${install}:ancestor-install`, directory: ancestor });
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    return names.toSorted((left, right) => (left.name < right.name ? -1 : 1));
  }

  private namespace(outputRoot?: string) {
    if (this.topology === undefined) {
      const traversal = this.readTopology();
      let next = traversal.next();
      while (!next.done) {
        next = traversal.next(fs.readdirSync(next.value.realDirectory, { withFileTypes: true }));
      }
      this.topology = next.value;
    }
    // Workspace aliases can expose this producer's outputs as installed inputs.
    // Keep their link identities, and retain the same subtree for other consumers.
    let signature = this.namespaceDigests.get(outputRoot);
    if (signature === undefined) {
      signature = digest(
        namespaceEntries(this.topology, outputRoot)
          .map(({ name }) => name)
          .join("\0"),
      );
      this.namespaceDigests.set(outputRoot, signature);
    }
    return signature;
  }

  private toolInputs() {
    this.namespace();
    this.generatorInputs ??= [
      ...new Set([
        ...this.policy.generatorInputs.filter((file) =>
          fs.existsSync(path.resolve(this.rootDir, file)),
        ),
        ...(this.topology ?? []).flatMap(({ name, file }) =>
          file && this.policy.isGeneratorInput?.(name) ? [file] : [],
        ),
      ]),
    ].toSorted();
    return [...this.policy.toolchainFiles, ...this.generatorInputs];
  }

  private namespaceChanges(
    before: CompilerInputSnapshot,
    outputRoot?: string,
    producedFiles?: ReadonlySet<string>,
  ) {
    const identities = (entries: TopologyEntry[]) => {
      const result = new Map<string, string[]>();
      for (const { id, name } of entries) {
        const names = result.get(id) ?? [];
        names.push(name);
        result.set(id, names);
      }
      return result;
    };
    // Compare captured topology only. Decorated names contain link targets;
    // diagnostics must emit the separately captured logical identity instead.
    const previous = identities(namespaceEntries(before.topology ?? [], outputRoot));
    const current = identities(
      namespaceEntries(this.topology ?? [], outputRoot, producedFiles, before.topology),
    );
    const changes: { change: string; path: string }[] = [];
    let omitted = 0;
    for (const id of [...new Set([...previous.keys(), ...current.keys()])].toSorted()) {
      if (JSON.stringify(previous.get(id)) === JSON.stringify(current.get(id))) {
        continue;
      }
      if (
        changes.length >= 16 ||
        path.posix.isAbsolute(id) ||
        path.win32.isAbsolute(id) ||
        id.split(/[\\/]/u).includes("..")
      ) {
        omitted++;
        continue;
      }
      changes.push({
        change: !previous.has(id) ? "added" : !current.has(id) ? "removed" : "changed",
        path: id.length > 160 ? `${id.slice(0, 157)}...` : id,
      });
      // Leave room for category and omission count even with JSON escaping or UTF-8.
      if (Buffer.byteLength(diagnosticJson(changes)) > 4000) {
        changes.pop();
        omitted++;
      }
    }
    return { changes, omitted };
  }

  private toolchain() {
    this.tools ??= digest(
      JSON.stringify([
        process.versions.node,
        process.platform,
        process.arch,
        ...this.toolInputs().map((file) => this.hash(file)),
      ]),
    );
    return this.tools;
  }

  signature(config: string, args: string[], inputs: string[], outputRoot?: string) {
    const parsed = this.config(config);
    return digest(
      JSON.stringify(
        [
          ARTIFACT_CACHE_VERSION,
          this.namespace(outputRoot),
          outputRoot,
          this.toolchain(),
          config,
          args,
          parsed.options,
          parsed.roots.map((file) => portableRelativePath(this.rootDir, file)),
          parsed.files.map((file) => [portableRelativePath(this.rootDir, file), this.hash(file)]),
          inputs.map((file) => [file, this.hash(file)]),
        ],
        (_key, value: unknown) => {
          // TypeScript config paths use forward slashes even on Windows.
          const normalized = typeof value === "string" ? path.normalize(value) : value;
          return normalized === this.rootDir
            ? "."
            : typeof normalized === "string" && normalized.startsWith(`${this.rootDir}${path.sep}`)
              ? portableRelativePath(this.rootDir, normalized)
              : value;
        },
      ),
    );
  }

  matches(
    record: ArtifactRecord | undefined,
    config: string,
    args: string[],
    required: string[],
    outputRoot?: string,
  ) {
    try {
      return (
        record?.inputs !== undefined &&
        record.signature === this.signature(config, args, record.inputs, outputRoot) &&
        required.every((file) => Object.hasOwn(record.outputs, file)) &&
        (!outputRoot ||
          listCacheFiles(
            this.rootDir,
            [{ path: outputRoot, extensions: [".d.ts", ".d.mts", ".d.cts"] }],
            fs,
          ).every((file) =>
            Object.hasOwn(record.outputs, portableRelativePath(this.rootDir, file)),
          )) &&
        Object.entries(record.outputs).every(([file, hash]) => this.hash(file) === hash)
      );
    } catch {
      return false;
    }
  }

  /** Seal only successful compiler membership after its joined invocation. */
  seal(
    config: string,
    args: string[],
    inputs: string[],
    before: CompilerInputSnapshot,
    startedAt: number,
    outputRoot?: string,
    producedFiles?: ReadonlySet<string>,
  ) {
    // Sealing can read uncaptured configs and tools from before. Freeze once so
    // successive seals cannot promote those late reads to precompilation evidence.
    const previousInputs = (before.sealedInputs ??= new Map(before.files));
    const signature = this.signature(config, args, inputs, outputRoot);
    const previousNamespace = before.namespace(outputRoot);
    // A concurrent producer can add its exact declared files. Existing entries,
    // symlink identities, and every consumed input remain subject to their guards.
    const currentNamespace = producedFiles?.size
      ? digest(
          namespaceEntries(this.topology!, outputRoot, producedFiles, before.topology)
            .map(({ name }) => name)
            .join("\0"),
        )
      : this.namespace(outputRoot);
    const category =
      previousNamespace !== currentNamespace
        ? "namespace"
        : before.toolchain() !== this.toolchain()
          ? "toolchain"
          : JSON.stringify(before.config(config)) !== JSON.stringify(this.config(config))
            ? "config"
            : before.config(config).files.some((file) => before.hash(file) !== this.hash(file))
              ? "config-bytes"
              : undefined;
    if (category) {
      const diagnostic = {
        category,
        ...(category === "namespace"
          ? this.namespaceChanges(before, outputRoot, producedFiles)
          : {}),
      };
      throw new Error(
        `Boundary configuration or resolution topology changed during compilation: ${diagnosticJson(diagnostic)}`,
      );
    }
    for (const file of [...inputs, ...this.config(config).files, ...this.toolInputs()]) {
      const current = this.read(file);
      const previous = previousInputs.get(before.inputPath(file));
      // Captured identity survives clock ties; newly discovered inputs still use
      // the invocation-only ctime fence. Neither becomes a persisted cache key.
      const changed = previous
        ? previous.hash !== current.hash ||
          previous.ctimeMs !== current.ctimeMs ||
          previous.dev !== current.dev ||
          previous.ino !== current.ino
        : current.ctimeMs >= startedAt;
      if (changed) {
        throw new Error(`Boundary input changed during compilation: ${file}`);
      }
    }
    return {
      signature,
      inputs,
    };
  }
}
