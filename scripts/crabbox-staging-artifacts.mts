import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const outputNames = ["captures", "runs"] as const;
const maxEntries = 100_000;
const sha256 = /^[a-f0-9]{64}$/u;

function artifactPath(path: string) {
  const parts = path.split("/");
  return (
    path.length <= 4096 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    outputNames.some((name) => parts[0] === name) &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}

export const crabboxArtifactIdentitySchema = z.strictObject({
  dev: z.string(),
  ino: z.string(),
});
export type CrabboxArtifactIdentity = z.infer<typeof crabboxArtifactIdentitySchema>;

const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ path: z.string().refine(artifactPath), kind: z.literal("directory") }),
  z.strictObject({
    path: z.string().refine((path) => artifactPath(path) && path.includes("/")),
    kind: z.literal("file"),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(sha256),
  }),
]);
type CrabboxArtifactEntry = z.infer<typeof entrySchema>;

const evidenceFields = {
  version: z.literal(1),
  durable: z.boolean(),
  sourceIdentity: crabboxArtifactIdentitySchema,
  entries: z.array(entrySchema).max(maxEntries),
};
export const crabboxArtifactEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...evidenceFields, kind: z.literal("none") }),
  z.strictObject({
    ...evidenceFields,
    kind: z.literal("copied"),
    repository: z.strictObject({ path: z.string(), identity: crabboxArtifactIdentitySchema }),
    parents: z.strictObject({
      crabbox: crabboxArtifactIdentitySchema,
      wrapperArtifacts: crabboxArtifactIdentitySchema,
    }),
    destination: z.strictObject({ path: z.string(), identity: crabboxArtifactIdentitySchema }),
  }),
]);
export type CrabboxArtifactEvidence = z.infer<typeof crabboxArtifactEvidenceSchema>;
type CopiedEvidence = Extract<CrabboxArtifactEvidence, { kind: "copied" }>;

function identity(stat: BigIntStats): CrabboxArtifactIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(stat: BigIntStats, expected: CrabboxArtifactIdentity) {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}

function directory(path: string, expected?: CrabboxArtifactIdentity) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || (expected && !sameIdentity(stat, expected))) {
    throw new Error("artifact directory is missing, replaced, or not a real directory: " + path);
  }
  return stat;
}

function optionalDirectory(path: string) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) {
    throw new Error("artifact path must be a real directory: " + path);
  }
  return stat;
}

function sameFile(before: BigIntStats, after: BigIntStats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function names(path: string) {
  const found = readdirSync(path, { encoding: "buffer" });
  if (found.length > maxEntries) {
    throw new Error("artifact directory exceeds its entry limit");
  }
  return found
    .map((name) => {
      if (!isUtf8(name)) {
        throw new Error("artifact filename is not UTF-8");
      }
      return name.toString("utf8");
    })
    .toSorted();
}

function privateDirectory(path: string) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return identity(directory(path));
}

function hashFile(
  path: string,
  expected: BigIntStats,
  buffer: Buffer,
  target?: string,
  nondurable?: () => void,
) {
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(input, { bigint: true });
    if (
      !before.isFile() ||
      !sameFile(before, expected) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("artifact file changed or is not a supported regular file: " + path);
    }
    if (target !== undefined) {
      output = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(output, 0o600);
    }
    const hash = createHash("sha256");
    let remaining = Number(before.size);
    while (remaining > 0) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) {
        throw new Error("artifact file became shorter while reading: " + path);
      }
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        for (let written = 0; written < count;) {
          const size = writeSync(output, buffer, written, count - written);
          if (!size) {
            throw new Error("artifact copy made no progress: " + target);
          }
          written += size;
        }
      }
      remaining -= count;
    }
    if (
      !sameFile(before, fstatSync(input, { bigint: true })) ||
      !sameFile(before, lstatSync(path, { bigint: true }))
    ) {
      throw new Error("artifact file changed while reading: " + path);
    }
    if (output !== undefined) {
      if (!flushDescriptor(output)) {
        nondurable?.();
      }
    }
    return { bytes: Number(before.size), sha256: hash.digest("hex") };
  } finally {
    try {
      if (output !== undefined) {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
  }
}

type CopyTarget = {
  root: string;
  copied: CrabboxArtifactEntry[];
  nondurable: () => void;
};

function inventory(
  root: string,
  options: { target?: () => CopyTarget; destination?: boolean } = {},
) {
  const entries: CrabboxArtifactEntry[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const rootStat = optionalDirectory(root);
  if (!rootStat) {
    return entries;
  }
  if (options.destination && process.platform !== "win32" && (rootStat.mode & 0o777n) !== 0o700n) {
    throw new Error("preserved artifact destination permissions changed");
  }
  if (
    options.destination &&
    names(root).some((name) => !outputNames.some((output) => output === name))
  ) {
    throw new Error("preserved artifact destination gained an unexpected entry");
  }
  const walk = (path: string, relativePath: string, target?: CopyTarget, depth = 0) => {
    if (depth > 128) {
      throw new Error("artifact directory nesting exceeds its inspection limit");
    }
    if (!artifactPath(relativePath) || entries.length >= maxEntries) {
      throw new Error("artifact inventory contains an unsupported path or exceeds its entry limit");
    }
    const before = lstatSync(path, { bigint: true });
    if (before.isDirectory()) {
      if (
        options.destination &&
        process.platform !== "win32" &&
        (before.mode & 0o777n) !== 0o700n
      ) {
        throw new Error("preserved artifact directory permissions changed: " + path);
      }
      const entry = { path: relativePath, kind: "directory" as const };
      entries.push(entry);
      if (target) {
        privateDirectory(join(target.root, relativePath));
        target.copied.push(entry);
      }
      for (const name of names(path)) {
        walk(join(path, name), relativePath + "/" + name, target, depth + 1);
      }
      if (!sameFile(before, lstatSync(path, { bigint: true }))) {
        throw new Error("artifact directory changed while reading: " + path);
      }
    } else if (before.isFile()) {
      if (
        options.destination &&
        process.platform !== "win32" &&
        (before.mode & 0o777n) !== 0o600n
      ) {
        throw new Error("preserved artifact file permissions changed: " + path);
      }
      const entry = {
        path: relativePath,
        kind: "file" as const,
        ...hashFile(
          path,
          before,
          buffer,
          target && join(target.root, relativePath),
          target?.nondurable,
        ),
      };
      entries.push(entry);
      target?.copied.push(entry);
    } else {
      throw new Error("artifact must be a regular file or real directory: " + path);
    }
  };
  for (const name of outputNames) {
    const path = join(root, name);
    if (optionalDirectory(path)) {
      // Match the existing owner: an empty top-level output directory needs no copy.
      const target = names(path).length > 0 ? options.target?.() : undefined;
      walk(path, name, target);
    }
  }
  if (!sameFile(rootStat, directory(root, identity(rootStat)))) {
    throw new Error("artifact root changed during inspection");
  }
  return entries.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function sourceInventory(
  source: string,
  expected: CrabboxArtifactIdentity,
  target?: () => CopyTarget,
) {
  const before = directory(source, expected);
  const entries = inventory(join(source, ".crabbox"), { target });
  if (!sameFile(before, directory(source, expected))) {
    throw new Error("artifact source checkout changed during inspection");
  }
  return entries;
}

function copiedEntries(entries: CrabboxArtifactEntry[]) {
  const roots = new Set(
    entries.filter((entry) => entry.path.includes("/")).map((entry) => entry.path.split("/")[0]),
  );
  return entries.filter((entry) => roots.has(entry.path.split("/")[0]));
}

function sameInventory(
  actual: CrabboxArtifactEntry[],
  expected: CrabboxArtifactEntry[],
  allowMissing = false,
) {
  const recorded = new Map(expected.map((entry) => [entry.path, entry]));
  if (
    recorded.size !== expected.length ||
    actual.some((entry) => JSON.stringify(recorded.get(entry.path)) !== JSON.stringify(entry)) ||
    (!allowMissing && actual.length !== expected.length)
  ) {
    throw new Error("artifact layout or bytes do not match the preservation evidence");
  }
}

function overlaps(left: string, right: string) {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
  };
  return contains(left, right) || contains(right, left);
}

function verifyDestination(sourceCheckout: string, evidence: CopiedEvidence, partial = false) {
  const repository = evidence.repository.path;
  const retainedRoot = join(repository, ".crabbox", "wrapper-artifacts");
  if (
    !isAbsolute(repository) ||
    realpathSync(repository) !== repository ||
    dirname(evidence.destination.path) !== retainedRoot ||
    !basename(evidence.destination.path).startsWith("run-") ||
    overlaps(sourceCheckout, evidence.destination.path)
  ) {
    throw new Error(
      "artifact preservation destination is not independent of the disposable checkout",
    );
  }
  directory(repository, evidence.repository.identity);
  directory(join(repository, ".crabbox"), evidence.parents.crabbox);
  directory(retainedRoot, evidence.parents.wrapperArtifacts);
  const stat = directory(evidence.destination.path, evidence.destination.identity);
  if (process.platform !== "win32" && (stat.mode & 0o777n) !== 0o700n) {
    throw new Error("preserved artifact destination permissions changed");
  }
  sameInventory(
    inventory(evidence.destination.path, { destination: true }),
    partial ? evidence.entries : copiedEntries(evidence.entries),
  );
  directory(repository, evidence.repository.identity);
  directory(join(repository, ".crabbox"), evidence.parents.crabbox);
  directory(retainedRoot, evidence.parents.wrapperArtifacts);
  directory(evidence.destination.path, evidence.destination.identity);
}

/** Revalidate saved outputs; only missing source entries can be tolerated after partial disposal. */
export function verifyPreservedCrabboxArtifacts(
  sourceCheckout: string,
  value: CrabboxArtifactEvidence,
  allowMissing = false,
): void {
  const evidence = crabboxArtifactEvidenceSchema.parse(value);
  const sourceStat = optionalDirectory(sourceCheckout);
  const source = sourceStat ? realpathSync(sourceCheckout) : resolve(sourceCheckout);
  if (sourceStat && !sameIdentity(sourceStat, evidence.sourceIdentity)) {
    throw new Error("artifact source checkout was replaced");
  }
  if (evidence.kind === "none") {
    if (copiedEntries(evidence.entries).length !== 0) {
      throw new Error("no-output evidence contains artifacts requiring preservation");
    }
  } else {
    verifyDestination(source, evidence);
  }
  sameInventory(
    sourceStat ? sourceInventory(source, evidence.sourceIdentity) : [],
    evidence.entries,
    allowMissing,
  );
  if (sourceStat) {
    directory(source, evidence.sourceIdentity);
  }
}

function flushDescriptor(fd: number) {
  try {
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  }
}

function flushDirectory(path: string) {
  // Native Windows cannot flush directories through this Node API; its stage owner
  // already withholds durable orphan-recovery authority on that platform.
  if (process.platform === "win32") {
    return false;
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    return flushDescriptor(fd);
  } catch (error) {
    if (
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Copy only native run/capture outputs into a fresh, private original-repository destination. */
export function preserveCrabboxArtifacts(
  sourceCheckout: string,
  repositoryRoot: string,
  expectedRepositoryIdentity?: CrabboxArtifactIdentity,
): CrabboxArtifactEvidence | undefined {
  if (sourceCheckout === repositoryRoot) {
    return undefined;
  }
  const sourceIdentity = identity(directory(sourceCheckout));
  const source = realpathSync(sourceCheckout);
  const state: { copied?: CopiedEvidence } = {};
  const completed: CrabboxArtifactEntry[] = [];
  try {
    const entries = sourceInventory(source, sourceIdentity, () => {
      if (!state.copied) {
        const repositoryIdentity = identity(directory(repositoryRoot, expectedRepositoryIdentity));
        const repository = realpathSync(repositoryRoot);
        const crabbox = join(repository, ".crabbox");
        const retainedRoot = join(crabbox, "wrapper-artifacts");
        if (overlaps(source, retainedRoot)) {
          throw new Error("artifact preservation destination overlaps the disposable checkout");
        }
        for (const path of [crabbox, retainedRoot]) {
          if (!optionalDirectory(path)) {
            privateDirectory(path);
          }
        }
        const destination = mkdtempSync(join(retainedRoot, "run-"));
        chmodSync(destination, 0o700);
        state.copied = {
          version: 1,
          durable: process.platform !== "win32",
          kind: "copied",
          sourceIdentity,
          entries: [],
          repository: { path: repository, identity: repositoryIdentity },
          parents: {
            crabbox: identity(directory(crabbox)),
            wrapperArtifacts: identity(directory(retainedRoot)),
          },
          destination: { path: destination, identity: identity(directory(destination)) },
        };
      }
      return {
        root: state.copied.destination.path,
        copied: completed,
        nondurable: () => {
          state.copied!.durable = false;
        },
      };
    });
    directory(source, sourceIdentity);
    sameInventory(sourceInventory(source, sourceIdentity), entries);
    const copied = state.copied;
    if (!copied) {
      return { version: 1, durable: true, kind: "none", sourceIdentity, entries };
    }
    copied.entries = entries;
    verifyDestination(source, copied);
    for (const entry of completed.toReversed()) {
      if (entry.kind === "directory") {
        copied.durable =
          flushDirectory(join(copied.destination.path, entry.path)) && copied.durable;
      }
    }
    for (const path of [
      copied.destination.path,
      dirname(copied.destination.path),
      join(copied.repository.path, ".crabbox"),
      copied.repository.path,
    ]) {
      copied.durable = flushDirectory(path) && copied.durable;
    }
    directory(source, sourceIdentity);
    console.error(
      `[crabbox] preserved temporary artifacts: ${join(source, ".crabbox")} -> ${relative(repositoryRoot, copied.destination.path)}`,
    );
    return copied;
  } catch (error) {
    const copied = state.copied;
    if (copied) {
      try {
        // Remove only a fully recognized partial copy. Interrupted writes or added
        // entries remain visible beside the original source for manual disposition.
        verifyDestination(source, { ...copied, entries: completed }, true);
        rmSync(copied.destination.path, { recursive: true });
      } catch {
        throw new Error(
          "artifact preservation failed; partial output may remain at " + copied.destination.path,
          { cause: error },
        );
      }
    }
    throw error;
  }
}
