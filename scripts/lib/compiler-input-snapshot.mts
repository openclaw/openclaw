import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CompilerOptions } from "typescript/unstable/sync";
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
  runtimeVersion?: string;
  isGeneratorInput?: (file: string) => boolean;
  assertInput?: (file: string) => string;
};
type TopologyEntry = { id: string; name: string; directory: string; file?: string };
type NamespaceDirectory = { directory: string; realDirectory: string; installed: boolean };
type CapturedInput = { bytes: Buffer; hash: string };
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const PREPARATION_CONCURRENCY = 16;

function namespaceEntries(entries: TopologyEntry[], outputRoot?: string) {
  return entries.filter(
    ({ directory }) =>
      !outputRoot ||
      (directory !== outputRoot && !directory.startsWith(`${outputRoot}${path.sep}`)),
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
  private readonly configs = new Map<
    string,
    { files: string[]; roots: string[]; options: CompilerOptions }
  >();
  private topology?: TopologyEntry[];
  private readonly namespaceDigests = new Map<string | undefined, string>();
  private generatorInputs?: string[];
  private readonly policy: CompilerInputPolicy;
  private tools?: string;
  private toolPaths?: string;
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
      entry = this.capture(absolute, fs.readFileSync(absolute));
    }
    return entry;
  }

  private capture(file: string, bytes: Buffer) {
    const entry = { bytes, hash: digest(bytes) };
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
          this.capture(file, await fs.promises.readFile(file));
        }
      },
    );
  }

  hash = (file: string) => this.read(file).hash;

  /** Supply the compiler and cache signature with the same captured bytes. */
  readText = (file: string) => this.read(file).bytes.toString("utf8");

  private config(file: string) {
    let result = this.configs.get(file);
    if (!result) {
      try {
        const parsed = readNativeTypeScriptConfig({
          cwd: this.rootDir,
          configFileName: this.inputPath(file),
          readFile: this.readText,
          assertInput: this.policy.assertInput,
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

  private toolchain() {
    this.tools ??= digest(
      JSON.stringify([
        this.policy.runtimeVersion ?? process.versions.node,
        process.platform,
        process.arch,
        ...this.toolInputs().map((file) => this.hash(file)),
      ]),
    );
    return this.tools;
  }

  private toolchainPaths() {
    this.toolPaths ??= digest(
      JSON.stringify(
        this.toolInputs().map((file) => {
          const absolute = this.inputPath(file);
          return [
            portableRelativePath(this.rootDir, absolute),
            portableRelativePath(this.rootDir, this.inputPath(fs.realpathSync.native(absolute))),
          ];
        }),
      ),
    );
    return this.toolPaths;
  }

  signature(
    config: string,
    args: string[],
    inputs: string[],
    outputRoot?: string,
    resolutionFingerprint?: string,
  ) {
    const parsed = this.config(config);
    const namespace = this.namespace(outputRoot);
    return digest(
      JSON.stringify(
        [
          ARTIFACT_CACHE_VERSION,
          resolutionFingerprint === undefined
            ? namespace
            : [
                "compiler-lookups",
                resolutionFingerprint,
                this.toolchainPaths(),
                (this.topology ?? [])
                  .filter(
                    ({ id, name }) => path.isAbsolute(id) && name === `${id}:ancestor-install`,
                  )
                  .map(({ name }) => name),
              ],
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
    resolutionFingerprint?: string,
  ) {
    try {
      return (
        record?.inputs !== undefined &&
        record.signature ===
          this.signature(config, args, record.inputs, outputRoot, resolutionFingerprint) &&
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
}
