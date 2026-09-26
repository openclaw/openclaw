import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { sha256FileSync } from "@openclaw/fs-safe/durability";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { z } from "zod";
import {
  mirrorStatStamp,
  openSourceMirror,
  recordMirrorEntry,
  type MirrorFile,
} from "./crabbox-source-mirror.mts";
import { captureSourceWitness } from "./crabbox-staging-witness.mts";
import { createMirrorStaging, createStaging, type StagingHandle } from "./crabbox-staging.mts";

const bundleFile = ".openclaw-crabbox-changed-gate.bundle";
const capsuleRef = "refs/openclaw/source-capsule";
const syncPlanSchema = z.object({
  candidate: z.object({ files: z.number().int().nonnegative() }),
  topFiles: z.array(z.object({ path: z.string().min(1) })),
});

export type CrabboxSourceCapsule = {
  sourceSha: string;
  baseSha: string;
  tree: string;
  carrier: string;
  digest: string;
  bundlePath: string;
  directory: string;
  cleanup: () => void;
  staging: StagingHandle;
  configPath?: string;
};

function sourceGitEnvironment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  };
  // Repository routing belongs to the selected checkout. Keep Git configuration
  // here: the invoking user's global excludes are part of source selection.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_SHALLOW_FILE",
  ]) {
    delete env[key];
  }
  return env;
}

function capsulePath(path: string) {
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("source capsule contains an invalid repository path");
  }
  if (path.includes("\0") || path.includes("\\") || path === bundleFile) {
    throw new Error("source capsule path conflicts with its transport metadata");
  }
  return path;
}

function capsuleObjectId(value: string) {
  const id = value.trim();
  if (!/^[a-f0-9]{40}$/u.test(id)) {
    throw new Error("source capsule requires a complete SHA-1 Git object identity");
  }
  return id;
}

function sourceStat(root: string, path: string) {
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      return { kind: "missing" } as const;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      // An indexed directory can be replaced by a file or symlink. Its old
      // descendants are deleted source, never paths into the new link's target.
      return { kind: "replaced" } as const;
    }
  }
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  return stat ? { kind: "present" as const, stat } : { kind: "missing" as const };
}

function hasUnverifiedGitPreparation(
  directory: string,
  env: NodeJS.ProcessEnv,
  sourcePaths: Iterable<string>,
) {
  if (env.GIT_CONFIG || env.GIT_EXTERNAL_DIFF) {
    return true;
  }
  const probe = (args: string[]) =>
    spawnSync("git", ["-C", directory, "config", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
  // Configuration reads do not invoke these callbacks. Their successful parent
  // command would not prove that any callback descendants had stopped.
  const callbacks = probe([
    "--null",
    "--name-only",
    "--get-regexp",
    "^(core\\.(fsmonitor|hookspath)|filter\\..*\\.(clean|smudge|process)|diff\\.(external|.*\\.(command|textconv)))$",
  ]);
  if (!callbacks.error && callbacks.status === 1) {
    return false;
  }
  if (callbacks.error || callbacks.status !== 0 || !isUtf8(callbacks.stdout)) {
    return true;
  }
  const names = callbacks.stdout.toString("utf8").toLowerCase().split("\0").filter(Boolean);
  if (
    !names.length ||
    names.some(
      (name) =>
        name !== "core.fsmonitor" && name !== "core.hookspath" && !name.startsWith("filter."),
    )
  ) {
    return true;
  }
  // Git renders these driver names identically to inactive attribute states.
  if (names.some((name) => /^filter\.(unset|unspecified)\./u.test(name))) {
    return true;
  }
  if (names.includes("core.hookspath")) {
    const hooks = probe(["--null", "--get", "core.hooksPath"]);
    if (hooks.error || hooks.status !== 0 || !hooks.stdout.equals(Buffer.from("/dev/null\0"))) {
      return true;
    }
  }
  if (names.includes("core.fsmonitor")) {
    // Typed config reads reject an overridden callback path before reaching the
    // effective local false. Inspect that last value without interpreting older ones.
    const effective = probe(["--null", "--get", "core.fsmonitor"]);
    const disabled =
      !effective.error && effective.status === 0 && effective.stdout.equals(Buffer.from("false\0"));
    const monitor = disabled ? undefined : probe(["--type=bool", "--get", "core.fsmonitor"]);
    if (
      monitor &&
      (monitor.error || monitor.status !== 0 || monitor.stdout.toString("utf8").trim() !== "false")
    ) {
      return true;
    }
  }
  if (!names.some((name) => name.startsWith("filter."))) {
    return false;
  }
  // Installed drivers such as Git LFS cannot run without an active path
  // attribute. Ask Git in this context, including its global attributes.
  const paths = [...sourcePaths];
  const attributes = spawnSync("git", ["-C", directory, "check-attr", "-z", "--stdin", "filter"], {
    env,
    input: paths.length ? paths.join("\0") + "\0" : "",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (attributes.error || attributes.status !== 0 || !isUtf8(attributes.stdout)) {
    return true;
  }
  const values = attributes.stdout.toString("utf8").split("\0");
  if (values.pop() !== "" || values.length !== paths.length * 3) {
    return true;
  }
  return paths.some(
    (path, index) =>
      values[index * 3] !== path ||
      values[index * 3 + 1] !== "filter" ||
      !["unspecified", "unset"].includes(values[index * 3 + 2]!),
  );
}

export function prepareCrabboxSourceCapsule(options: {
  repoRoot: string;
  syncRoot: string;
  base: string;
  reuseMirror?: boolean;
  syncPlan: { command: string; args: string[]; windowsVerbatimArguments?: boolean };
}): CrabboxSourceCapsule {
  const startedAt = Date.now();
  const repoRoot = realpathSync(options.repoRoot);
  const sourceEnv = sourceGitEnvironment();
  function git(cwd: string, args: string[], env = sourceEnv, input?: string) {
    let output: Buffer;
    try {
      output = execFileSync(
        "git",
        [
          "-C",
          cwd,
          ...(options.reuseMirror && cwd === repoRoot ? ["-c", "core.fsmonitor=false"] : []),
          ...args,
        ],
        {
          env,
          input,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      throw new Error(`source capsule: git ${args[0]} failed; source was not uploaded`);
    }
    if (!isUtf8(output)) {
      throw new Error("source capsule requires UTF-8 Git paths and metadata");
    }
    return output.toString("utf8");
  }
  const sourceSha = capsuleObjectId(git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
  const baseSha = capsuleObjectId(
    git(repoRoot, ["rev-parse", "--verify", `${options.base}^{commit}`]),
  );
  const trackedRecords = git(repoRoot, ["ls-files", "-v", "--stage", "-z"]);
  const tracked = new Map<string, { mode: string; hash: string; sparse: boolean }>();
  for (const record of trackedRecords.split("\0").filter(Boolean)) {
    const match = /^([A-Za-z]) (100644|100755|120000) ([a-f0-9]{40}) 0\t([\s\S]+)$/u.exec(record);
    if (!match || !match[1] || !match[2] || !match[3] || !match[4]) {
      throw new Error("source capsule requires resolved regular-file or symlink index entries");
    }
    tracked.set(capsulePath(match[4]), {
      mode: match[2],
      hash: match[3],
      sparse: match[1].toUpperCase() === "S",
    });
  }
  const owned = new Set(tracked.keys());
  for (const revision of new Set([baseSha, sourceSha])) {
    for (const path of git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", revision])
      .split("\0")
      .filter(Boolean)) {
      owned.add(capsulePath(path));
    }
  }
  // Freeze invoking Git's eligibility before moving to a different Git/config
  // context. This includes staged ignored additions and excludes untracked secrets.
  const eligiblePaths = git(repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  const eligible = new Set(eligiblePaths.map(capsulePath));
  function stamp(path: string) {
    const entry = sourceStat(repoRoot, path);
    return entry.kind === "present" ? mirrorStatStamp(entry.stat) : entry.kind;
  }
  // Capture before staging allocation and Git setup, not when each copy finally
  // reaches the path. Recheck eligibility too: new or newly ignored files must
  // not silently change the frozen policy's source set.
  const observed = new Map<string, string>();
  for (const path of new Set(
    [...eligible].toSorted().concat([".crabboxignore", ".crabbox.yaml", "crabbox.yaml"]),
  )) {
    observed.set(path, stamp(path));
  }
  mkdirSync(options.syncRoot, { recursive: true });
  const witness = captureSourceWitness(repoRoot, sourceSha);
  function allocateMirror() {
    const allocated = createMirrorStaging(options.syncRoot, repoRoot);
    if (allocated && !allocated.staging.recorded) {
      allocated.discard();
      throw new Error("source mirror requires recorded staging; source was not uploaded");
    }
    return allocated;
  }
  let mirror = options.reuseMirror && witness ? allocateMirror() : undefined;
  let cache: ReturnType<typeof openSourceMirror> | undefined;
  try {
    if (mirror) {
      const context = {
        gitVersion: git(repoRoot, ["--version"]).trim(),
        witness: witness ? JSON.stringify(witness) : "",
      };
      try {
        cache = openSourceMirror(
          mirror.staging.root,
          join(mirror.staging.payload, "source"),
          mirror.reused,
          context,
        );
      } catch (error) {
        if (!mirror.reused) {
          throw error;
        }
        console.error("[crabbox] source mirror failed verification; rebuilding a cold capsule");
        mirror.discard();
        mirror = allocateMirror();
        if (mirror) {
          cache = openSourceMirror(
            mirror.staging.root,
            join(mirror.staging.payload, "source"),
            false,
            context,
          );
        }
      }
    }
  } catch (error) {
    mirror?.discard();
    throw error;
  }
  const staging = mirror?.staging ?? createStaging(options.syncRoot, repoRoot);
  const temporary = staging.payload;
  const directory = join(temporary, "source");
  let complete = false;
  const cleanup = () => {
    cache?.close();
    if (mirror) {
      if (complete) {
        mirror.finish();
      } else {
        mirror.discard();
      }
    } else {
      staging.dispose();
    }
  };
  try {
    const warm = mirror?.reused ?? false;
    mkdirSync(directory, { recursive: true });
    const privateEnv: NodeJS.ProcessEnv = {
      ...sourceEnv,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "OpenClaw",
      GIT_AUTHOR_EMAIL: "ci@openclaw.local",
      GIT_COMMITTER_NAME: "OpenClaw",
      GIT_COMMITTER_EMAIL: "ci@openclaw.local",
    };
    delete privateEnv.GIT_CONFIG_PARAMETERS;
    delete privateEnv.GIT_CONFIG;
    if (!warm) {
      git(directory, ["init", "--quiet", "--template="], privateEnv);
    }
    if (mirror) {
      // Prevent callback writers instead of weakening the preparation hold.
      // Local config also applies when native Git strips command-scoped config.
      git(directory, ["config", "core.hooksPath", "/dev/null"], privateEnv);
      git(directory, ["config", "core.fsmonitor", "false"], privateEnv);
    }
    const objectDir = git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();
    writeFileSync(join(directory, ".git", "objects", "info", "alternates"), `${objectDir}\n`);
    git(directory, ["update-ref", "--no-deref", "HEAD", sourceSha], privateEnv);
    // Native Blacksmith sync compares against literal main. Use the captured
    // base so committed source changes remain part of that transport delta.
    git(directory, ["update-ref", "refs/heads/main", baseSha], privateEnv);
    // Git expands ~/ paths; relative excludesFile paths are relative to the source
    // checkout. Keep this policy reference local, including an explicit empty override.
    const excludesFile = spawnSync(
      "git",
      ["-C", repoRoot, "config", "--path", "--null", "--get", "core.excludesFile"],
      {
        env: sourceEnv,
      },
    );
    if (excludesFile.status === 0 && isUtf8(excludesFile.stdout)) {
      const path = excludesFile.stdout.toString("utf8").slice(0, -1);
      git(
        directory,
        ["config", "core.excludesFile", path ? resolve(repoRoot, path) : ""],
        privateEnv,
      );
    } else if (excludesFile.status !== 1) {
      throw new Error("source capsule could not resolve Git exclusion policy");
    } else if (warm) {
      git(directory, ["config", "core.excludesFile", ""], privateEnv);
    }
    git(
      directory,
      [
        "remote",
        warm ? "set-url" : "add",
        "origin",
        git(repoRoot, ["remote", "get-url", "origin"]).trim(),
      ],
      privateEnv,
    );
    // Original tracking, not the eventual raw candidate index, controls Crabbox's
    // tracked-source exceptions. Untracked candidates must remain untracked here.
    if (warm) {
      rmSync(join(directory, ".git", "index"));
      copyFileSync(
        join(directory, ".git", "mirror-selection-index"),
        join(directory, ".git", "index"),
      );
    }
    const previousTracked = new Map<string, string>();
    for (const record of (cache?.tracked ?? "").split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      previousTracked.set(record.slice(tab + 1), record.slice(2, tab));
    }
    const trackingChanges: string[] = [];
    const changedTracking = new Set<string>();
    for (const path of previousTracked.keys()) {
      if (!tracked.has(path)) {
        trackingChanges.push(`0 ${"0".repeat(40)}\t${path}\0`);
      }
    }
    for (const [path, entry] of tracked) {
      if (previousTracked.get(path) !== `${entry.mode} ${entry.hash} 0`) {
        trackingChanges.push(`${entry.mode} ${entry.hash}\t${path}\0`);
        changedTracking.add(path);
      }
    }
    git(directory, ["update-index", "-z", "--index-info"], privateEnv, trackingChanges.join(""));
    const exclude = git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]).trim();
    const excludeInfo = lstatSync(exclude, { throwIfNoEntry: false });
    if (excludeInfo) {
      const policy = realpathSync(exclude);
      if (!lstatSync(policy).isFile()) {
        throw new Error("source capsule requires a regular Git info/exclude policy file");
      }
      mkdirSync(join(directory, ".git", "info"), { recursive: true });
      const fd = openSync(policy, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        writeFileSync(join(directory, ".git", "info", "exclude"), readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    } else if (warm) {
      rmSync(join(directory, ".git", "info", "exclude"), { force: true });
    }
    const frozen = new Map<
      string,
      { mode: string; blobPath: string; blob?: string; stamp?: string }
    >();
    const retained = new Set<string>();
    function removeFrozen(path: string) {
      rmSync(join(directory, path));
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        try {
          rmdirSync(join(directory, parent));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
            throw error;
          }
          break;
        }
      }
    }
    // Remove old namespaces before adding new ones (file <-> directory changes).
    for (const [path, previous] of cache?.files ?? []) {
      if (!eligible.has(path)) {
        removeFrozen(path);
        continue;
      }
      const source = observed.get(path)!;
      const sparse = tracked.get(path);
      const token =
        source === "missing" && sparse?.sparse ? `sparse:${sparse.mode}:${sparse.hash}` : source;
      if (previous.source !== token) {
        removeFrozen(path);
      } else {
        retained.add(path);
      }
    }
    if (warm) {
      rmSync(join(directory, bundleFile));
    }
    let copiedFiles = 0;
    let reusedFiles = 0;
    const linkBlobs = join(temporary, "links");
    mkdirSync(linkBlobs);
    function writeFailure(path: string, operation: string, error: unknown) {
      const failure = error as NodeJS.ErrnoException;
      const details = [
        failure?.code === undefined ? undefined : `code=${JSON.stringify(failure.code)}`,
        failure?.errno === undefined ? undefined : `errno=${JSON.stringify(failure.errno)}`,
      ]
        .filter(Boolean)
        .join(", ");
      return new Error(
        `source capsule: ${operation} failed for ${JSON.stringify(path)}${details ? ` (${details})` : ""}; source was not uploaded`,
        { cause: error },
      );
    }
    function writeFrozen(path: string, bytes: Buffer, mode: string) {
      const destination = join(directory, path);
      let blobPath = destination;
      let operation = "mkdir";
      try {
        mkdirSync(dirname(destination), { recursive: true });
        if (mode === "120000") {
          operation = "symlink";
          symlinkSync(bytes, destination);
          blobPath = join(linkBlobs, String(frozen.size));
          operation = "write symlink blob";
          writeFileSync(blobPath, bytes);
        } else {
          operation = "write file";
          writeFileSync(destination, bytes);
          operation = "chmod";
          chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
        }
      } catch (error) {
        throw writeFailure(path, operation, error);
      }
      frozen.set(path, {
        mode,
        blobPath,
        stamp: cache ? mirrorStatStamp(lstatSync(destination)) : undefined,
      });
      copiedFiles += 1;
    }
    function copySource(path: string) {
      const previous = cache?.files.get(path);
      if (retained.has(path) && previous) {
        // The initial source observation selects reuse; the final source pass
        // still rejects edits during freezing, including paths we did not copy.
        frozen.set(path, {
          mode: previous.mode,
          blobPath: join(directory, path),
          blob: previous.blob,
          stamp: previous.stamp,
        });
        reusedFiles += 1;
        return "present";
      }
      const entry = sourceStat(repoRoot, path);
      const source = entry.kind === "present" ? mirrorStatStamp(entry.stat) : entry.kind;
      if (observed.has(path) && observed.get(path) !== source) {
        throw new Error(
          `source changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
        );
      }
      observed.set(path, source);
      if (entry.kind !== "present" || entry.stat.isDirectory()) {
        return entry.kind;
      }
      const info = entry.stat;
      const sourcePath = join(repoRoot, path);
      if (info.isSymbolicLink()) {
        const bytes = readlinkSync(sourcePath, { encoding: "buffer" });
        const after = sourceStat(repoRoot, path);
        if (
          after.kind !== "present" ||
          !after.stat.isSymbolicLink() ||
          after.stat.ino !== info.ino ||
          !readlinkSync(sourcePath, { encoding: "buffer" }).equals(bytes) ||
          mirrorStatStamp(after.stat) !== source
        ) {
          throw new Error(
            `symlink changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
          );
        }
        writeFrozen(path, bytes, "120000");
        return "present";
      }
      if (!info.isFile()) {
        throw new Error(`source capsule has an unsupported file kind at ${JSON.stringify(path)}`);
      }
      const destination = join(directory, path);
      const mode = (info.mode & 0o100) !== 0 ? "100755" : "100644";
      const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        let operation = "mkdir";
        let output: number;
        try {
          mkdirSync(dirname(destination), { recursive: true });
          operation = "write file";
          output = openSync(destination, "wx");
        } catch (error) {
          throw writeFailure(path, operation, error);
        }
        try {
          let copied: number;
          try {
            copied = copyFileDescriptorSync(fd, output, { maxBytes: opened.size });
          } catch (error) {
            if (error instanceof FsSafeError && error.code === "too-large") {
              throw new Error(
                `source changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
                { cause: error },
              );
            }
            // Without callbacks, helper-failed can only mean a write made no progress.
            if (
              (error as NodeJS.ErrnoException)?.syscall === "write" ||
              (error instanceof FsSafeError && error.code === "helper-failed")
            ) {
              throw writeFailure(path, "write file", error);
            }
            throw error;
          }
          const after = sourceStat(repoRoot, path);
          if (
            !opened.isFile() ||
            after.kind !== "present" ||
            opened.ino !== info.ino ||
            opened.ino !== after.stat.ino ||
            mirrorStatStamp(opened) !== source ||
            mirrorStatStamp(after.stat) !== source ||
            opened.mode !== info.mode ||
            opened.mode !== after.stat.mode ||
            opened.size !== after.stat.size ||
            opened.mtimeMs !== after.stat.mtimeMs ||
            copied !== opened.size
          ) {
            throw new Error(
              `source changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
            );
          }
          try {
            chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
          } catch (error) {
            throw writeFailure(path, "chmod", error);
          }
        } finally {
          closeSync(output);
        }
      } finally {
        closeSync(fd);
      }
      frozen.set(path, {
        mode,
        blobPath: destination,
        stamp: cache ? mirrorStatStamp(lstatSync(destination)) : undefined,
      });
      copiedFiles += 1;
      return "present";
    }
    const sparse: Array<{ path: string; mode: string; hash: string }> = [];
    for (const path of [...eligible].toSorted()) {
      const kind = copySource(path);
      const entry = tracked.get(path);
      if (kind === "missing" && entry?.sparse) {
        sparse.push({ path, mode: entry.mode, hash: entry.hash });
      }
    }
    if (sparse.length) {
      // Batch directly to a private file: a sparse checkout can omit most of the
      // repository. Neither per-blob subprocesses nor one huge stdout buffer scales.
      const stream = join(temporary, "sparse-blobs");
      const output = openSync(stream, "wx", 0o600);
      try {
        execFileSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
          env: sourceEnv,
          input: sparse.map((entry) => entry.hash).join("\n") + "\n",
          stdio: ["pipe", output, "pipe"],
        });
      } catch {
        throw new Error("source capsule could not materialize missing sparse index blobs");
      } finally {
        closeSync(output);
      }
      const input = openSync(stream, "r");
      let offset = 0;
      try {
        for (const entry of sparse) {
          const headerBytes = Buffer.alloc(128);
          const headerSize = readSync(input, headerBytes, 0, headerBytes.length, offset);
          const newline = headerBytes.indexOf(10, 0);
          const header = headerBytes.subarray(0, newline).toString("ascii");
          const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(header);
          if (
            newline < 0 ||
            newline >= headerSize ||
            !match ||
            match[1] !== entry.hash ||
            !match[2]
          ) {
            throw new Error("source capsule received invalid sparse blob framing");
          }
          const size = Number(match[2]);
          if (!Number.isSafeInteger(size)) {
            throw new Error("source capsule sparse blob size is invalid");
          }
          offset += newline + 1;
          const bytes = Buffer.alloc(size);
          for (let read = 0; read < size;) {
            const count = readSync(input, bytes, read, size - read, offset + read);
            if (!count) {
              throw new Error("source capsule sparse blob was truncated");
            }
            read += count;
          }
          offset += size;
          const separator = Buffer.alloc(1);
          if (readSync(input, separator, 0, 1, offset) !== 1 || separator[0] !== 10) {
            throw new Error("source capsule sparse blob separator is missing");
          }
          offset += 1;
          writeFrozen(entry.path, bytes, entry.mode);
        }
        if (offset !== fstatSync(input).size) {
          throw new Error("source capsule sparse blob stream has unexpected data");
        }
      } finally {
        closeSync(input);
      }
    }
    const selectionEnv = { ...sourceEnv };
    const nativeGitEnv = Object.fromEntries(
      Object.entries(sourceEnv).filter(([key]) => {
        const name = key.toUpperCase();
        return (
          !name.startsWith("GIT_") ||
          name === "GIT_CEILING_DIRECTORIES" ||
          name === "GIT_DISCOVERY_ACROSS_FILESYSTEM"
        );
      }),
    );
    let preparationUnverified = false;
    const holdPreparation = () => {
      if (staging.recorded && !preparationUnverified) {
        staging.hold("writers");
        preparationUnverified = true;
      }
    };
    const checkPreparation = (env: NodeJS.ProcessEnv) => {
      if (
        staging.recorded &&
        !preparationUnverified &&
        hasUnverifiedGitPreparation(directory, env, new Set([...owned, ...frozen.keys()]))
      ) {
        holdPreparation();
      }
    };
    const runtimePolicies: string[] = [];
    let configPath: string | undefined;
    const explicitConfig = sourceEnv.CRABBOX_CONFIG;
    if (explicitConfig) {
      const original = resolve(repoRoot, explicitConfig);
      function repositoryPolicyPath(absolute: string) {
        const path = relative(repoRoot, absolute);
        return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
          ? capsulePath(path)
          : undefined;
      }
      let policyPath = repositoryPolicyPath(original);
      if (!policyPath) {
        // Crabbox also treats an external alias resolving into this repository
        // as repository configuration. Relocation must not elevate its trust.
        try {
          policyPath = repositoryPolicyPath(realpathSync(original));
        } catch {
          // Missing explicit configuration is permitted by Crabbox.
        }
      }
      if (policyPath) {
        runtimePolicies.push(policyPath);
        configPath = join(directory, policyPath);
      } else {
        configPath = original;
      }
      selectionEnv.CRABBOX_CONFIG = configPath;
    } else {
      runtimePolicies.push("crabbox.yaml", ".crabbox.yaml");
    }
    // Policy files may be Git-ignored. They affect selection but never become
    // transport candidates merely because selection needs to read them.
    for (const path of [...runtimePolicies, ".crabboxignore"]) {
      const kind = frozen.has(path) ? "present" : copySource(path);
      // A replaced policy must not become an absent file and lose its exclusions.
      if (kind !== "missing" && !["100644", "100755"].includes(frozen.get(path)?.mode ?? "")) {
        throw new Error(
          `source capsule cannot relocate non-regular repository policy ${JSON.stringify(path)}; use a regular policy file before uploading`,
        );
      }
    }
    checkPreparation(sourceEnv);
    const snapshotEligible = new Set(
      git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    );
    for (const path of frozen.keys()) {
      if (eligible.has(path) && !snapshotEligible.has(path)) {
        throw new Error("source capsule Git exclusion context changed in the frozen checkout");
      }
    }
    function selectSource() {
      checkPreparation(selectionEnv);
      // Current native Git discovery strips command-scoped Git configuration;
      // older supported CLIs retain it. Both preparation contexts must be safe.
      checkPreparation(nativeGitEnv);
      let planValue: unknown;
      try {
        const result = spawnSync(options.syncPlan.command, options.syncPlan.args, {
          cwd: directory,
          env: selectionEnv,
          windowsVerbatimArguments: options.syncPlan.windowsVerbatimArguments,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error || result.status !== 0) {
          throw new Error("Crabbox sync-plan failed");
        }
        planValue = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "source capsule requires a successful Crabbox sync-plan; inspect source exclusions before retrying",
        );
      }
      const parsed = syncPlanSchema.safeParse(planValue);
      if (!parsed.success) {
        throw new Error("source capsule received an invalid Crabbox sync-plan");
      }
      if (
        typeof planValue === "object" &&
        planValue !== null &&
        "localGitSeed" in planValue &&
        planValue.localGitSeed != null
      ) {
        // Its additional Git workspaces are outside this constructor's closure proof.
        holdPreparation();
      }
      const selected = new Set(parsed.data.topFiles.map((entry) => capsulePath(entry.path)));
      if (
        selected.size !== parsed.data.candidate.files ||
        selected.size !== parsed.data.topFiles.length
      ) {
        throw new Error("source capsule requires the complete, unique Crabbox sync-plan selection");
      }
      return selected;
    }
    function refreshIndex(paths: string[]) {
      if (!paths.length) {
        return;
      }
      const result = spawnSync(
        "git",
        [
          "-C",
          directory,
          ...(warm
            ? ["add", "--refresh", "--pathspec-from-file=-", "--pathspec-file-nul"]
            : ["update-index", "--refresh"]),
        ],
        {
          env: { ...privateEnv, GIT_LITERAL_PATHSPECS: "1" },
          input: warm ? paths.join("\0") + "\0" : undefined,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      // Dirty files legitimately need update; their existing tracked identity
      // must not be changed merely to seed stat data for policy selection.
      if (result.error || (result.status !== 0 && result.status !== 1)) {
        throw new Error("source capsule could not refresh its Git index");
      }
    }
    refreshIndex(
      [...tracked.keys()].filter(
        (path) => frozen.has(path) && (!warm || !retained.has(path) || changedTracking.has(path)),
      ),
    );
    if (cache) {
      // Deletion probes temporarily unstage missing entries. Save original
      // tracking first so a later restored ignored file keeps its tracked status.
      copyFileSync(
        join(directory, ".git", "index"),
        join(directory, ".git", "mirror-selection-index"),
      );
    }
    const directories = new Set<string>();
    for (const path of frozen.keys()) {
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        directories.add(parent);
      }
    }
    // Ask the same policy owner about absent source using empty tracked placeholders.
    // These never enter the source tree. Separate overlapping historical file paths
    // (a -> a/b) so no probe follows a source symlink or shadows another deletion.
    const groups: Set<string>[] = [new Set()];
    for (const path of [...owned].toSorted()) {
      if (frozen.has(path) || directories.has(path)) {
        continue;
      }
      const parents: string[] = [];
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        parents.push(parent);
      }
      if (parents.some((parent) => frozen.has(parent))) {
        continue; // The selected ancestor replaces this namespace without following it.
      }
      let group = groups.find((entries) => parents.every((parent) => !entries.has(parent)));
      if (!group) {
        group = new Set();
        groups.push(group);
      }
      group.add(path);
    }
    const emptyBlob = git(directory, ["hash-object", "-w", "--stdin"], privateEnv, "").trim();
    const unstageDeletions = (paths: Iterable<string>) =>
      git(
        directory,
        ["update-index", "-z", "--index-info"],
        privateEnv,
        [...paths].map((path) => `0 ${"0".repeat(40)}\t${path}\0`).join(""),
      );
    unstageDeletions(groups.flatMap((group) => [...group]));
    const deleted: string[] = [];
    let selected: Set<string> | undefined;
    for (const group of groups) {
      for (const path of group) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), "", { flag: "wx" });
      }
      git(
        directory,
        ["update-index", "-z", "--index-info"],
        privateEnv,
        [...group].map((path) => `100644 ${emptyBlob}\t${path}\0`).join(""),
      );
      const current = selectSource();
      for (const path of group) {
        if (current.delete(path)) {
          deleted.push(path);
        }
        removeFrozen(path);
      }
      unstageDeletions(group);
      if (
        selected &&
        (selected.size !== current.size || [...selected].some((path) => !current.has(path)))
      ) {
        throw new Error("source capsule policy changed while selecting deletions");
      }
      selected = current;
    }
    if (!selected) {
      throw new Error("source capsule selection is missing");
    }
    for (const path of tracked.keys()) {
      if (frozen.has(path) && !selected.has(path)) {
        throw new Error(
          `source capsule privacy selection excludes required tracked source ${JSON.stringify(path)}; resolve the conflict before uploading`,
        );
      }
    }
    for (const path of selected) {
      if (frozen.has(path)) {
        continue;
      }
      const parts = path.split("/");
      const replacedTrackedPath =
        tracked.has(path) &&
        parts.some((_, index) => index > 0 && frozen.has(parts.slice(0, index).join("/")));
      if (!replacedTrackedPath) {
        throw new Error("source capsule selection contains an absent source entry");
      }
    }
    const paths = [...selected].filter((path) => eligible.has(path) && frozen.has(path)).toSorted();
    const finalPaths = new Set(paths);
    for (const path of runtimePolicies) {
      if (frozen.has(path) && !finalPaths.has(path)) {
        throw new Error(
          `source capsule cannot retain excluded repository runtime configuration ${JSON.stringify(path)} for staged delegation`,
        );
      }
    }
    for (const path of frozen.keys()) {
      if (!finalPaths.has(path)) {
        removeFrozen(path);
      }
    }
    // Hash frozen bytes without attributes or filters. Link blob inputs contain
    // readlink bytes, never the referent's contents; only selected blobs enter Git.
    const unhashed = paths.filter((path) => !frozen.get(path)!.blob);
    const newHashes = git(
      directory,
      ["hash-object", "-w", "--no-filters", "--stdin-paths"],
      privateEnv,
      unhashed.map((path) => JSON.stringify(frozen.get(path)!.blobPath)).join("\n") +
        (unhashed.length ? "\n" : ""),
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (
      newHashes.length !== unhashed.length ||
      newHashes.some((hash) => !/^[a-f0-9]{40}$/u.test(hash))
    ) {
      throw new Error("source capsule could not freeze every raw blob");
    }
    for (const [index, path] of unhashed.entries()) {
      frozen.get(path)!.blob = newHashes[index]!;
    }
    const hashes = paths.map((path) => frozen.get(path)!.blob!);
    if (warm) {
      rmSync(join(directory, ".git", "index"));
      copyFileSync(
        join(directory, ".git", "mirror-candidate-index"),
        join(directory, ".git", "index"),
      );
    } else {
      git(directory, ["read-tree", "--empty"], privateEnv);
    }
    const candidateChanges: string[] = [];
    for (const path of cache?.files.keys() ?? []) {
      if (!finalPaths.has(path)) {
        candidateChanges.push(`0 ${"0".repeat(40)}\t${path}\0`);
      }
    }
    for (const path of paths) {
      const entry = frozen.get(path)!;
      const previous = cache?.files.get(path);
      if (!warm || previous?.mode !== entry.mode || previous.blob !== entry.blob) {
        candidateChanges.push(`${entry.mode} ${entry.blob}\t${path}\0`);
      }
    }
    if (warm) {
      candidateChanges.unshift(`0 ${"0".repeat(40)}\t${bundleFile}\0`);
    }
    git(directory, ["update-index", "-z", "--index-info"], privateEnv, candidateChanges.join(""));
    const tree = capsuleObjectId(git(directory, ["write-tree"], privateEnv));
    const carrier = capsuleObjectId(
      git(
        directory,
        ["commit-tree", tree, "-p", baseSha],
        privateEnv,
        JSON.stringify({ deleted }) + "\n",
      ),
    );
    git(directory, ["update-ref", capsuleRef, carrier], privateEnv);
    const shallow = join(temporary, "shallow");
    writeFileSync(shallow, `${baseSha}\n`);
    const bundlePath = join(directory, bundleFile);
    git(directory, ["bundle", "create", bundlePath, `${baseSha}..${capsuleRef}`], {
      ...privateEnv,
      GIT_SHALLOW_FILE: shallow,
    });
    const descriptor = openSync(bundlePath, "r");
    let digest: string;
    try {
      digest = sha256FileSync(descriptor).digest;
    } finally {
      closeSync(descriptor);
    }
    const bundleHash = capsuleObjectId(
      git(directory, ["hash-object", "-w", "--no-filters", bundlePath], privateEnv),
    );
    git(
      directory,
      ["update-index", "--add", "--cacheinfo", `100644,${bundleHash},${bundleFile}`],
      privateEnv,
    );
    refreshIndex([...paths.filter((path) => !warm || !retained.has(path)), bundleFile]);
    if (cache) {
      copyFileSync(
        join(directory, ".git", "index"),
        join(directory, ".git", "mirror-candidate-index"),
      );
    }
    for (const [path, source] of observed) {
      if (stamp(path) !== source) {
        throw new Error(
          `source changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
        );
      }
    }
    const localStage = relative(repoRoot, staging.root);
    const localStagePrefix =
      localStage &&
      localStage !== ".." &&
      !localStage.startsWith(`..${sep}`) &&
      !isAbsolute(localStage)
        ? `${localStage.split(sep).join("/")}/`
        : undefined;
    const finalEligible = git(repoRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean)
      // Unmarked repo-local staging is supported. Only this newly allocated
      // generation is output rather than source; sibling edits still invalidate.
      .filter((path) => !localStagePrefix || !path.startsWith(localStagePrefix));
    if (
      git(repoRoot, ["rev-parse", "HEAD"]).trim() !== sourceSha ||
      git(repoRoot, ["ls-files", "-v", "--stage", "-z"]) !== trackedRecords ||
      finalEligible.join("\0") !== eligiblePaths.join("\0")
    ) {
      throw new Error(
        "source revision, index, or eligibility changed while freezing; retry after edits finish",
      );
    }
    // Preparation-only copies are no longer needed after the transport bundle
    // is sealed. Keep recovery metadata outside the recursively removed payload.
    rmSync(linkBlobs, { recursive: true, force: true });
    rmSync(join(temporary, "sparse-blobs"), { force: true });
    rmSync(shallow, { force: true });
    const mirrorInventory = cache ? new Map<string, string>() : undefined;
    if (staging.recorded) {
      checkPreparation(sourceEnv);
      checkPreparation(nativeGitEnv);
      staging.prepared(
        {
          files: paths.map((path, index) => ({
            path,
            mode: frozen.get(path)!.mode as "100644" | "100755" | "120000",
            blob: hashes[index]!,
          })),
          deleted,
        },
        witness,
        mirrorInventory
          ? (path, stat) => {
              if (path.startsWith("source/")) {
                recordMirrorEntry(mirrorInventory, path.slice("source/".length), stat);
              }
            }
          : undefined,
      );
    }
    if (cache && mirrorInventory) {
      const next = new Map<string, MirrorFile>();
      for (const path of paths) {
        const entry = frozen.get(path)!;
        const indexed = tracked.get(path);
        const observedSource = observed.get(path)!;
        next.set(path, {
          path,
          source:
            observedSource === "missing" && indexed?.sparse
              ? `sparse:${indexed.mode}:${indexed.hash}`
              : observedSource,
          stamp: entry.stamp!,
          mode: entry.mode as MirrorFile["mode"],
          blob: entry.blob!,
        });
      }
      cache.save(next, trackedRecords, mirrorInventory);
      console.error(
        `[crabbox] source mirror ${warm ? "warm" : "cold"}: copied ${copiedFiles} files, reused ${reusedFiles} files; preparation ${Date.now() - startedAt}ms`,
      );
    }
    complete = true;
    return {
      sourceSha,
      baseSha,
      tree,
      carrier,
      digest,
      bundlePath,
      directory,
      cleanup,
      staging,
      configPath,
    };
  } catch (error) {
    try {
      cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `source capsule cleanup failed; temporary checkout retained at ${temporary}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
