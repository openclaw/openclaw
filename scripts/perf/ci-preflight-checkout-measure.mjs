// Compare full-tree materialization; shared local objects deliberately exclude network transfer.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: process.cwd() },
    revision: { type: "string", default: "HEAD" },
    samples: { type: "string", default: "5" },
    output: { type: "string" },
    "sparse-path": { type: "string", multiple: true },
  },
});
if (!values.output) {
  throw new Error("--output is required");
}
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) {
  throw new Error("--samples must be positive");
}
const source = path.resolve(values.source);
const output = path.resolve(values.output);
const root = path.dirname(output);
mkdirSync(root, { recursive: true });
const sparsePaths = values["sparse-path"] ?? [];
let traceFile;

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TRACE2_EVENT: traceFile },
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr);
  }
  return result.stdout;
}

const revision = git(source, "rev-parse", `${values.revision}^{commit}`).trim();
const saved = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined;
const rows = saved?.rows ?? [];
if (saved && JSON.stringify(saved.sparsePaths ?? []) !== JSON.stringify(sparsePaths)) {
  throw new Error("Saved sparse paths differ");
}
if (rows.some((row) => row.revision !== revision) || rows.length % 2) {
  throw new Error("Incomplete or mismatched saved pair");
}
for (let sample = rows.length / 2; sample < samples; sample++) {
  for (const variant of sparsePaths.length ? ["full", "sparse"] : [1, 2]) {
    const workers = typeof variant === "number" ? variant : 1;
    const directory = mkdtempSync(path.join(root, "materialize-"));
    try {
      git(
        source,
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        "--single-branch",
        source,
        directory,
      );
      // Match a freshly initialized Actions checkout: configuring sparse patterns
      // must not materialize the clone's default HEAD before measurement starts.
      git(directory, "symbolic-ref", "HEAD", "refs/heads/materialization-fixture-unborn");
      const load = loadavg();
      traceFile = path.join(directory, "checkout-trace.jsonl");
      const start = performance.now();
      if (variant === "sparse") {
        git(directory, "sparse-checkout", "set", "--no-cone", ...sparsePaths);
      }
      git(directory, "-c", `checkout.workers=${workers}`, "checkout", "--detach", revision);
      const seconds = (performance.now() - start) / 1000;
      traceFile = undefined;
      const profile = readFileSync(path.join(directory, "checkout-trace.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      rmSync(path.join(directory, "checkout-trace.jsonl"));
      if (
        git(directory, "rev-parse", "HEAD").trim() !== revision ||
        git(directory, "status", "--porcelain")
      ) {
        throw new Error("Checkout identity or content differs");
      }
      const files = git(directory, "ls-files", "-t", "-z")
        .split("\0")
        .filter((entry) => entry && !entry.startsWith("S "))
        .map((entry) => entry.slice(2));
      for (const pattern of sparsePaths) {
        const name = pattern.replace(/^\//u, "");
        if (
          readFileSync(path.join(directory, name), "utf8") !==
          git(source, "show", `${revision}:${name}`)
        ) {
          throw new Error(`Sparse input differs: ${name}`);
        }
      }
      const bytes = files.reduce(
        (total, name) => total + lstatSync(path.join(directory, name)).size,
        0,
      );
      const row = {
        sample,
        variant,
        workers,
        revision,
        seconds,
        load,
        files: files.length,
        bytes,
        profile,
      };
      rows.push(row);
      writeFileSync(
        output,
        `${JSON.stringify({ scope: "fresh-worktree-shared-local-objects", source, revision, sparsePaths, rows }, null, 2)}\n`,
      );
      console.log(JSON.stringify({ ...row, profile: undefined }));
    } finally {
      traceFile = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
