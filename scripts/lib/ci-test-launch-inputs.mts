import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isObservationPath } from "./ci-test-observations.mjs";

const MAX_BYTES = 1024 * 1024;
const sha = /^[a-f0-9]{40}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Change = { status: string; path: string; previousPath?: string };

function readBounded(file: string) {
  if (statSync(file).size > MAX_BYTES) {
    throw new Error("Launch input exceeds the byte limit");
  }
  return readFileSync(file);
}

// Freeze only inputs known to the wrapper. Native inventory belongs to the reporter.
export function writeCiTestLaunchInputs(options: {
  directory: string;
  repositoryRoot: string;
  runtime: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}) {
  const { env } = options;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: options.repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: MAX_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
  const fallbackReasons = ["no-prior-snapshot"];
  let source: { revision: string; tree: string; clean: boolean } | null = null;
  let comparison: { revision: string; tree: string; changes: Change[] } | null = null;
  try {
    const revision = git("rev-parse", "--verify", "HEAD").trim();
    const tree = git("rev-parse", "--verify", "HEAD^{tree}").trim();
    if (!sha.test(revision) || !sha.test(tree)) {
      throw new Error("Invalid source identity");
    }
    const clean = git("status", "--porcelain=v1", "--untracked-files=normal", "-z") === "";
    source = { revision, tree, clean };
    if (!clean) {
      fallbackReasons.push("dirty-checkout");
    }
    const base = env.CHECKOUT_BASE_SHA;
    if (!base || !sha.test(base)) {
      throw new Error("Missing comparison base");
    }
    const baseRevision = git("rev-parse", "--verify", `${base}^{commit}`).trim();
    const baseTree = git("rev-parse", "--verify", `${base}^{tree}`).trim();
    const fields = git(
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      baseRevision,
      revision,
      "--",
    ).split("\0");
    if (fields.pop() !== "") {
      throw new Error("Incomplete comparison diff");
    }
    const changes: Change[] = [];
    for (let index = 0; index < fields.length;) {
      const status = fields[index++] ?? "";
      const first = fields[index++] ?? "";
      const renamed = /^R\d{1,3}$/.test(status);
      const file = renamed ? (fields[index++] ?? "") : first;
      if (
        !/^(?:[ADMTUXB]|R\d{1,3})$/.test(status) ||
        !isObservationPath(first) ||
        !isObservationPath(file)
      ) {
        throw new Error("Invalid comparison path");
      }
      changes.push({ status, path: file, ...(renamed ? { previousPath: first } : {}) });
    }
    comparison = { revision: baseRevision, tree: baseTree, changes };
  } catch {
    fallbackReasons.push(source ? "comparison-unavailable" : "source-unavailable");
  }
  const includes = ["OPENCLAW_VITEST_INCLUDE_FILE", "OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE"].map(
    (key) => {
      try {
        return env[key] ? hash(readBounded(env[key])) : null;
      } catch {
        fallbackReasons.push("selection-input-unavailable");
        return null;
      }
    },
  );
  const inputs = {
    version: 1,
    recordedAt: new Date().toISOString(),
    source,
    comparison,
    selection: {
      runtime: options.runtime,
      argsDigest: hash(JSON.stringify(options.args)),
      includes,
    },
    mode: "shadow",
    fallbackReasons: [...new Set(fallbackReasons)],
  };
  const json = JSON.stringify(inputs);
  if (Buffer.byteLength(json) > MAX_BYTES) {
    throw new Error("Launch inputs exceed the byte limit");
  }
  writeFileSync(path.join(options.directory, "launch.json"), json);
}

// Preserve the exact parent-written bytes through a hash, without exporting arbitrary JSON.
export function readCiTestLaunchInputs(directory: string) {
  try {
    const json = readBounded(path.join(directory, "launch.json"));
    return { sha256: hash(json) };
  } catch {
    return null;
  }
}
