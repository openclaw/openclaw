// Measure compiled-worker startup through real process/input/cleanup boundaries.
// These intentionally rejected inputs isolate eager startup, not successful work.
// node scripts/perf/update-worker-load.mjs <compiled-root> <output-dir>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [rootArg, outputArg] = process.argv.slice(2);
assert.ok(rootArg && outputArg, "Specify compiled root and fresh output directory");
const root = path.resolve(rootArg);
const output = path.resolve(outputArg);
mkdirSync(output, { recursive: true });
const preload = fileURLToPath(new URL("./update-worker-load-preload.mjs", import.meta.url));
const worker = path.join(root, "dist/infra/update-migrated-finalize.worker.js");
const results = [];
for (const mode of [
  "--check",
  "--settle-plugin-cohort",
  "--commit-plugin-cohort",
  "--doctor",
  "--post-core",
  "finalize",
]) {
  const state = path.join(output, mode.replaceAll("-", ""));
  mkdirSync(state, { recursive: true });
  const child = spawnSync(
    process.execPath,
    ["--import", preload, worker, ...(mode === "finalize" ? [] : [mode])],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: state,
        USERPROFILE: state,
        TMPDIR: state,
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_STATE_DIR: path.join(state, "state"),
        OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        OPENCLAW_BENCH_UPDATE_LOAD_DIR: state,
      },
      input: "{}",
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, mode === "--check" ? 0 : 1, child.stderr);
  const captures = readdirSync(state).filter((name) => /^load-\d+-\d+\.json$/.test(name));
  assert.ok(captures.length > 0, "Missing runtime load capture");
  const threads = captures.map((name) => JSON.parse(readFileSync(path.join(state, name), "utf8")));
  results.push({
    mode,
    status: child.status,
    threads,
    capability: mode === "--check" ? JSON.parse(child.stdout) : undefined,
  });
}
writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
