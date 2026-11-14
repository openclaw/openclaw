// Resolves the diff base for merge commits when first-parent comparison is requested.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { requireOptionArgument } from "./arg-utils.runtime.mjs";

const DEFAULT_GIT_OUTPUT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Resolve a commit without allowing Git's unnegotiated promisor fetch.
 * @param {string} ref
 * @param {string} [cwd]
 * @returns {string}
 */
export function ensureGitCommit(ref, cwd = process.cwd()) {
  /** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
  const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  /** @param {string} revision */
  const local = (revision) =>
    execFileSync("git", ["rev-parse", "--verify", "--end-of-options", revision], {
      ...options,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    }).trim();
  try {
    return local(`${ref}^{commit}`);
  } catch {
    // A local ref can name an absent object even after its remote branch advances.
    const object = local(ref);
    execFileSync(
      "git",
      [
        "fetch",
        "--no-auto-maintenance",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "--",
        "origin",
        object,
      ],
      options,
    );
    return local(`${object}^{commit}`);
  }
}

/**
 * Resolve the git base ref to use when diffing a merge head.
 * @param {{base: string, head?: string, cwd?: string, maxBuffer?: number, preferFirstParent?: boolean}} params
 * @returns {string}
 */
export function resolveMergeHeadDiffBase({
  base,
  head = "HEAD",
  cwd = process.cwd(),
  maxBuffer = DEFAULT_GIT_OUTPUT_MAX_BUFFER,
  preferFirstParent = false,
}) {
  if (!base) {
    return "";
  }
  if (!preferFirstParent) {
    return base;
  }

  const parents = listCommitParents({ ref: head, cwd, maxBuffer });
  if (parents.length < 2) {
    return base;
  }

  // The merge parent is authoritative. Resolving a stale base in a partial
  // clone can fetch unrelated history even when its result is discarded.
  return parents[0];
}

/**
 * @param {{ref: string, cwd: string, maxBuffer: number}} params
 * @returns {string[]}
 */
function listCommitParents({ ref, cwd, maxBuffer }) {
  const commit = ensureGitCommit(ref, cwd);
  try {
    const output = execFileSync("git", ["rev-list", "--parents", "-n", "1", commit], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer,
    }).trim();
    return output.split(/\s+/u).slice(1);
  } catch {
    return [];
  }
}

/**
 * @internal Directly tested script implementation detail.
 * @param {readonly string[]} argv
 * @returns {{base: string, head: string, preferFirstParent: boolean}}
 */
export function parseArgs(argv) {
  const args = {
    base: "",
    head: "HEAD",
    preferFirstParent: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      args.base = requireOptionArgument(argv, index, "--base");
      index += 1;
      continue;
    }
    if (arg === "--head") {
      args.head = requireOptionArgument(argv, index, "--head");
      index += 1;
      continue;
    }
    if (arg === "--prefer-first-parent") {
      args.preferFirstParent = true;
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `${resolveMergeHeadDiffBase({
      base: args.base,
      head: args.head,
      preferFirstParent: args.preferFirstParent,
    })}\n`,
  );
}
