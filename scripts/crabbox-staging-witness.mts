import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

type FrozenSourceEntry = {
  path: string;
  mode: "100644" | "100755" | "120000";
  blob: string;
};

export type FrozenSource = { files: FrozenSourceEntry[]; deleted: string[] };
export type SourceWitness = { gitDir: string; ref: string; commit: string };
export type SourceWitnessResult =
  | { ok: true; witness: SourceWitness; revalidate: () => void }
  | { ok: false; reason: string; error: unknown; unjoined?: true };

const objectId = /^[0-9a-f]{40}$/u;
const sourceModes = new Set(["100644", "100755", "120000"]);
const maxEntries = 100_000;
const maxMetadataBytes = 64 * 1024 * 1024;
const maxSourceBytes = 8 * 1024 * 1024 * 1024;
const verificationBudgetMs = 120_000;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const gitOptions = [
  "--no-lazy-fetch",
  "--no-replace-objects",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
];

function remainingTime(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("source witness verification exceeded its work budget");
  }
  return remaining;
}

function gitRead(
  location: string[],
  args: string[],
  deadline: number,
  options: { absent?: boolean; quiet?: boolean } = {},
): Buffer | undefined {
  const result = spawnSync("git", [...gitOptions, ...location, ...args], {
    env: gitEnvironment(),
    stdio: ["ignore", options.quiet ? "ignore" : "pipe", "pipe"],
    timeout: remainingTime(deadline),
    killSignal: "SIGKILL",
    maxBuffer: options.quiet ? 1024 * 1024 : maxMetadataBytes,
  });
  if (!result.error && options.absent && result.status === 1) {
    return undefined;
  }
  if (result.error || result.status !== 0) {
    throw new Error(`source witness Git ${args[0]} could not verify local objects`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function gitText(location: string[], args: string[], deadline: number) {
  const value = gitRead(location, args, deadline)!;
  if (!isUtf8(value)) {
    throw new Error("source witness Git metadata is not UTF-8");
  }
  return value.toString("utf8").trim();
}

function retainedRef(ref: string) {
  return (
    ref.startsWith("refs/") &&
    ref.length <= 1024 &&
    !ref.endsWith("/HEAD") &&
    !ref.includes("\\") &&
    !ref.includes("\0") &&
    !ref.split("/").some((part) => !part || part === "." || part === "..") &&
    ![
      "refs/openclaw/source-capsule",
      "refs/bisect/",
      "refs/rewritten/",
      "refs/worktree/",
      "refs/replace/",
    ].some(
      (prefix) => ref === prefix || ref.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )
  );
}

function resolveRef(location: string[], ref: string, deadline: number) {
  if (!retainedRef(ref)) {
    throw new Error("source witness needs a named non-staging Git ref");
  }
  gitRead(location, ["check-ref-format", ref], deadline);
  if (gitRead(location, ["symbolic-ref", "--quiet", ref], deadline, { absent: true })) {
    throw new Error("source witness ref must name retained objects directly");
  }
  const oid = gitText(location, ["rev-parse", "--verify", "--end-of-options", ref], deadline);
  const commit = gitText(
    location,
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    deadline,
  );
  if (!objectId.test(oid) || !objectId.test(commit)) {
    throw new Error("source witness requires complete SHA-1 Git identities");
  }
  return { oid, commit };
}

/** Capture only an existing branch or exact ref, without searching commit history. */
export function captureSourceWitness(
  repoRoot: string,
  sourceSha: string,
): SourceWitness | undefined {
  try {
    if (!objectId.test(sourceSha)) {
      return undefined;
    }
    const deadline = Date.now() + 5_000;
    const location = ["-C", repoRoot];
    const gitDir = realpathSync(
      gitText(location, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline),
    );
    const symbolic = gitRead(location, ["symbolic-ref", "--quiet", "HEAD"], deadline, {
      absent: true,
    });
    const refs = symbolic
      ? [symbolic.toString("utf8").trim()]
      : gitText(
          location,
          [
            "for-each-ref",
            "--count=32",
            "--format=%(refname)",
            "--points-at",
            sourceSha,
            "refs/heads",
            "refs/remotes",
            "refs/tags",
          ],
          deadline,
        ).split("\n");
    for (const ref of refs.filter(retainedRef)) {
      const resolved = resolveRef(location, ref, deadline);
      if (resolved.commit === sourceSha) {
        return { gitDir, ref, commit: sourceSha };
      }
    }
  } catch {
    // A missing or ambiguous retained ref is a preservation hold, never a new ref.
  }
  return undefined;
}

/** Select an operator-owned retained ref without creating refs or copying source. */
export function selectSourceWitness(repository: string, ref: string): SourceWitness {
  if (!retainedRef(ref)) {
    throw new Error(
      "Choose a full retained refs/heads, refs/remotes, or refs/tags name outside staging.",
    );
  }
  const deadline = Date.now() + 5_000;
  const location = ["-C", repository];
  const gitDir = realpathSync(
    gitText(location, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline),
  );
  return { gitDir, ref, commit: resolveRef(location, ref, deadline).commit };
}

function overlaps(left: string, right: string) {
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  return within(left, right) || within(right, left);
}

function sourcePath(path: string) {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    Buffer.from(path).toString("utf8") !== path ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("source witness manifest has an invalid repository path");
  }
  return path;
}

function validateSource(source: FrozenSource) {
  if (source.files.length + source.deleted.length > maxEntries) {
    throw new Error("source witness manifest exceeds its entry budget");
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of source.files) {
    const path = sourcePath(entry.path);
    if (files.has(path) || !sourceModes.has(entry.mode) || !objectId.test(entry.blob)) {
      throw new Error("source witness manifest has duplicate or invalid source entries");
    }
    files.add(path);
    for (let slash = path.lastIndexOf("/"); slash >= 0; slash = path.lastIndexOf("/", slash - 1)) {
      directories.add(path.slice(0, slash));
    }
  }
  if ([...files].some((path) => directories.has(path))) {
    throw new Error("source witness manifest has conflicting file and directory paths");
  }
  const deleted = new Set<string>();
  for (const entry of source.deleted) {
    const path = sourcePath(entry);
    if (deleted.has(path) || files.has(path) || directories.has(path)) {
      throw new Error("source witness manifest has conflicting deletions");
    }
    deleted.add(path);
  }
}

/** First eligibility tier: an ordinary self-contained local object store. */
function storageIdentity(gitDir: string, payloadRoot: string, ref: string, deadline: number) {
  const digest = createHash("sha256");
  let count = 0;
  const record = (path: string) => {
    remainingTime(deadline);
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      digest.update(`${path}\0missing\0`);
      return undefined;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(
        "source witness Git storage contains a symbolic link or unsupported file kind",
      );
    }
    if (++count > 250_000) {
      throw new Error("source witness object storage exceeds its inspection budget");
    }
    digest.update(
      `${path}\0${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\0`,
    );
    return stat;
  };
  if (
    realpathSync(gitDir) !== gitDir ||
    overlaps(gitDir, payloadRoot) ||
    !record(gitDir)?.isDirectory()
  ) {
    throw new Error("source witness Git repository overlaps the disposable payload");
  }
  for (const name of [
    "HEAD",
    "config",
    "config.worktree",
    "packed-refs",
    "commondir",
    "shallow",
    "info/grafts",
    ref,
  ]) {
    // Loose refs and metadata must not route back into the payload through an ancestor link.
    const parts = name.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      const parent = record(join(gitDir, ...parts.slice(0, end)));
      if (parent && !parent.isDirectory()) {
        throw new Error("source witness Git metadata has an unsupported parent path");
      }
    }
    const path = join(gitDir, name);
    const stat = record(path);
    if (stat && !stat.isFile()) {
      throw new Error("source witness Git metadata is not a regular file");
    }
    if (stat && ["commondir", "shallow", "info/grafts"].includes(name) && stat.size > 0n) {
      throw new Error(
        "source witness needs complete local history without redirected or truncated storage",
      );
    }
  }
  const walk = (directory: string, depth: number) => {
    if (depth > 4 || !record(directory)?.isDirectory()) {
      throw new Error("source witness object storage has an unsupported directory layout");
    }
    for (const name of readdirSync(directory).toSorted()) {
      const path = join(directory, name);
      const stat = record(path);
      if (!stat) {
        throw new Error("source witness object storage changed during inspection");
      }
      if (name.endsWith(".promisor")) {
        throw new Error(
          "source witness has promised objects; choose an independent complete store",
        );
      }
      if ((name === "alternates" || name === "http-alternates") && stat.size > 0n) {
        throw new Error("source witness borrows objects; choose an independent complete store");
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
      }
    }
  };
  walk(join(gitDir, "objects"), 0);
  return digest.digest("hex");
}

async function verifyBlobs(
  location: string[],
  blobs: string[],
  deadline: number,
  signal?: AbortSignal,
) {
  if (blobs.length === 0) {
    return;
  }
  const abort = new AbortController();
  let failure: Error | undefined;
  let header = "";
  let index = 0;
  let remaining = 0;
  let bytes = 0;
  let hash: Hash | undefined;
  const consume = (chunk: Buffer) => {
    try {
      for (let offset = 0; offset < chunk.length;) {
        if (failure) {
          return;
        }
        if (remaining > 0) {
          const end = offset + Math.min(remaining, chunk.length - offset);
          hash!.update(chunk.subarray(offset, end));
          remaining -= end - offset;
          offset = end;
        } else if (hash) {
          if (chunk[offset++] !== 10 || hash.digest("hex") !== blobs[index]) {
            throw new Error("source witness raw blob identity mismatch");
          }
          hash = undefined;
          index += 1;
        } else {
          const value = chunk[offset++];
          if (value !== 10) {
            header += String.fromCharCode(value!);
            if (header.length > 128) {
              throw new Error("source witness returned invalid object framing");
            }
            continue;
          }
          const match = /^([0-9a-f]{40}) blob (0|[1-9][0-9]*)$/u.exec(header);
          if (!match || match[1] !== blobs[index]) {
            throw new Error("source witness raw blob is missing or has the wrong type");
          }
          remaining = Number(match[2]);
          bytes += remaining;
          if (!Number.isSafeInteger(remaining) || bytes > maxSourceBytes) {
            throw new Error("source witness raw blobs exceed the verification byte budget");
          }
          hash = createHash("sha1").update(`blob ${remaining}\0`);
          header = "";
        }
      }
    } catch (error) {
      failure =
        error instanceof Error ? error : new Error("source witness blob verification failed");
      abort.abort(failure);
    }
  };
  try {
    const status = await runManagedCommand({
      bin: "git",
      args: [...gitOptions, ...location, "cat-file", "--batch"],
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: remainingTime(deadline),
      signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
      requireProcessTreeExit: true,
      onReady(child) {
        child.stdout!.on("data", consume);
        child.stderr!.resume();
        child.stdin!.on("error", () => {});
        child.stdin!.end(`${blobs.join("\n")}\n`);
      },
    });
    if (status !== 0 || failure || hash || header || index !== blobs.length) {
      throw failure ?? new Error("source witness did not supply every complete raw blob");
    }
  } catch (error) {
    if (failure && failure !== error) {
      // A parser-triggered abort can also fail to settle the Git child tree.
      throw new AggregateError([failure, error], failure.message, { cause: error });
    }
    throw error;
  }
}

/** Read-only proof of another retained copy; the stage owner still owns disposal. */
export async function verifySourceWitness(params: {
  source: FrozenSource;
  witness: SourceWitness;
  payloadRoot: string;
  signal?: AbortSignal;
}): Promise<SourceWitnessResult> {
  try {
    params.signal?.throwIfAborted();
    validateSource(params.source);
    const { ref: refName, commit } = params.witness;
    if (!objectId.test(commit) || !retainedRef(refName)) {
      throw new Error("source witness needs an exact commit and named non-staging ref");
    }
    const deadline = Date.now() + verificationBudgetMs;
    const payloadRoot = realpathSync(params.payloadRoot);
    const gitDir = realpathSync(params.witness.gitDir);
    const location = [`--git-dir=${gitDir}`];
    const before = storageIdentity(gitDir, payloadRoot, refName, deadline);
    const unsupported = gitRead(
      location,
      [
        "config",
        "--no-includes",
        "--get-regexp",
        "^(include\\.|includeif\\.|extensions\\.(partialclone|refstorage)|remote\\..*\\.promisor$|fsck\\.)",
      ],
      deadline,
      { absent: true },
    );
    if (unsupported) {
      throw new Error(
        "source witness uses configuration that prevents independent local verification",
      );
    }
    if (gitText(location, ["rev-parse", "--show-object-format"], deadline) !== "sha1") {
      throw new Error("source witness requires a SHA-1 Git object store");
    }
    const ref = resolveRef(location, refName, deadline);
    gitRead(location, ["merge-base", "--is-ancestor", commit, ref.commit], deadline);
    // No history object-ID list is buffered. Promisor/alternate routing was rejected above.
    gitRead(
      location,
      ["fsck", "--connectivity-only", "--no-dangling", "--no-reflogs", "--no-progress", ref.oid],
      deadline,
      { quiet: true },
    );
    const listing = gitRead(
      location,
      ["ls-tree", "-r", "-t", "-z", "--full-tree", commit],
      deadline,
    )!;
    if (!isUtf8(listing)) {
      throw new Error("source witness tree paths are not UTF-8");
    }
    const entries = new Map<string, { mode: string; blob: string }>();
    for (const row of listing.toString("utf8").split("\0").filter(Boolean)) {
      const match =
        /^(040000 tree|100644 blob|100755 blob|120000 blob|160000 commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(
          row,
        );
      if (!match || !match[1] || !match[2] || !match[3] || entries.has(match[3])) {
        throw new Error("source witness tree has unsupported or duplicate entries");
      }
      entries.set(sourcePath(match[3]), { mode: match[1].slice(0, 6), blob: match[2] });
    }
    for (const entry of params.source.files) {
      const saved = entries.get(entry.path);
      if (saved?.mode !== entry.mode || saved.blob !== entry.blob) {
        throw new Error(`source witness does not preserve ${JSON.stringify(entry.path)}`);
      }
    }
    for (const path of params.source.deleted) {
      if (entries.has(path)) {
        throw new Error(`source witness does not preserve deletion of ${JSON.stringify(path)}`);
      }
    }
    await verifyBlobs(
      location,
      [...new Set(params.source.files.map((entry) => entry.blob))],
      deadline,
      params.signal,
    );
    const revalidate = () => {
      params.signal?.throwIfAborted();
      const currentStorage = storageIdentity(gitDir, payloadRoot, refName, deadline);
      const after = resolveRef(location, refName, deadline);
      if (currentStorage !== before || after.oid !== ref.oid || after.commit !== ref.commit) {
        throw new Error("source witness changed while preservation was being verified");
      }
    };
    revalidate();
    // The owner must repeat this check after its final payload pass, immediately before disposal.
    return { ok: true, witness: { gitDir, ref: refName, commit }, revalidate };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "source witness could not be verified",
      error,
      ...(hasUnjoinedWork(error) ? { unjoined: true as const } : {}),
    };
  }
}
