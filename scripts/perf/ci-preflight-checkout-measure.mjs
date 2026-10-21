// Compare full-tree materialization; shared local objects deliberately exclude network transfer.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr);
  }
  return result.stdout;
}

const revision = git(source, "rev-parse", `${values.revision}^{commit}`).trim();
/** @type {{sample: number, workers: number, revision: string, seconds: number, load: number[]}[]} */
const rows = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")).rows : [];
if (rows.some((row) => row.revision !== revision) || rows.length % 2) {
  throw new Error("Incomplete or mismatched saved pair");
}
for (let sample = rows.length / 2; sample < samples; sample++) {
  for (const workers of [1, 2]) {
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
      const load = loadavg();
      const start = performance.now();
      git(directory, "-c", `checkout.workers=${workers}`, "checkout", "--detach", revision);
      const seconds = (performance.now() - start) / 1000;
      if (
        git(directory, "rev-parse", "HEAD").trim() !== revision ||
        git(directory, "status", "--porcelain")
      ) {
        throw new Error("Checkout identity or content differs");
      }
      const row = { sample, workers, revision, seconds, load };
      rows.push(row);
      writeFileSync(
        output,
        `${JSON.stringify({ scope: "fresh-worktree-shared-local-objects", source, revision, rows }, null, 2)}\n`,
      );
      console.log(JSON.stringify(row));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
