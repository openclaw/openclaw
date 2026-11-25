/**
 * Linux: node scripts/perf/cli-bootstrap-imports-measure.mjs --base <full-sha> --pairs 5
 * Build qaRuntime first. Runs the complete production guard in fresh processes,
 * against one unchanged build, alternating baseline/candidate. Only the guard
 * source differs; its import closure and installed dependencies must match.
 * Cold/warm refer to separate Node compile-cache states, not storage caches.
 * GNU time includes the guard's worker children. Counts are a separate untimed
 * traversal of the actual worker bundles; no Gateway or whole-CI claim.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { visitJavaScriptStatements } from "../lib/javascript-statements.mjs";

const { values } = parseArgs({
  options: { base: { type: "string" }, pairs: { type: "string", default: "5" } },
});
assert(process.platform === "linux", "GNU time on Linux is required");
assert(/^[a-f0-9]{40}$/u.test(values.base ?? ""), "--base must be a full commit SHA");
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs >= 5 && pairs <= 20);
const root = fileURLToPath(new URL("../../", import.meta.url));
const guard = "scripts/check-cli-bootstrap-imports.mts";
const baselineSource = execFileSync("git", ["show", `${values.base}:${guard}`], { cwd: root });
const candidateSource = fs.readFileSync(path.join(root, guard));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const baselinePath = path.join(root, "scripts", `.bootstrap-measure-${process.pid}.mts`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-measure-"));
const workerFiles = fs
  .readdirSync(path.join(root, "dist/worker"))
  .filter((f) => f.endsWith(".mjs"))
  .toSorted();
assert(workerFiles.length > 0, "Build qaRuntime first");
const inventory = () =>
  workerFiles.map((name) => {
    const bytes = fs.readFileSync(path.join(root, "dist/worker", name));
    return { name, bytes: bytes.length, sha256: hash(bytes) };
  });
const before = inventory();
const records = [];
fs.writeFileSync(baselinePath, baselineSource, { flag: "wx" });
try {
  console.log(
    JSON.stringify({
      event: "workload",
      base: values.base,
      node: process.version,
      guardHashes: { baseline: hash(baselineSource), candidate: hash(candidateSource) },
      lockfileHash: hash(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
      workerFiles: before.length,
      workerBytes: before.reduce((n, f) => n + f.bytes, 0),
      workerHash: hash(JSON.stringify(before)),
      cpus: os.availableParallelism(),
      memory: os.totalmem(),
      load: os.loadavg(),
    }),
  );
  const run = (arm, cache, pair) => {
    const env = {
      ...process.env,
      NODE_COMPILE_CACHE: path.join(
        temporary,
        `${cache}-${arm}${cache === "cold" ? `-${pair}` : ""}`,
      ),
    };
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const metrics = path.join(temporary, "time.txt");
    const loadBefore = os.loadavg();
    const result = spawnSync(
      "/usr/bin/time",
      [
        "-f",
        "%e %U %S %M",
        "-o",
        metrics,
        process.execPath,
        "--import",
        "./scripts/tsx.mjs",
        arm === "baseline" ? baselinePath : guard,
      ],
      { cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      result.status,
      0,
      `${arm} guard failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    const [seconds, userSeconds, systemSeconds, maxRssKiB] = fs
      .readFileSync(metrics, "utf8")
      .trim()
      .split(/\s+/u)
      .map(Number);
    assert([seconds, userSeconds, systemSeconds, maxRssKiB].every(Number.isFinite));
    const record = {
      arm,
      cache,
      pair,
      seconds,
      cpuSeconds: userSeconds + systemSeconds,
      maxRssMiB: maxRssKiB / 1024,
      loadBefore,
      loadAfter: os.loadavg(),
    };
    console.log(JSON.stringify({ event: "sample", ...record }));
    if (pair >= 0) {
      records.push(record);
    }
    return result.stdout;
  };
  for (const cache of ["cold", "warm"]) {
    if (cache === "warm") {
      assert.equal(run("baseline", cache, -1), run("candidate", cache, -1));
    }
    for (let pair = 0; pair < pairs; pair++) {
      assert.equal(
        run("baseline", cache, pair),
        run("candidate", cache, pair),
        "Guard output changed",
      );
    }
  }
  assert.deepEqual(inventory(), before, "Built worker artifacts changed during measurement");
  const counts = { objects: 0, leaves: 0, leafMetadata: 0 };
  for (const name of workerFiles) {
    visitJavaScriptStatements(
      fs.readFileSync(path.join(root, "dist/worker", name), "utf8"),
      { sourceType: "module", allowHashBang: true },
      (statements) => {
        const stack = statements;
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== "object") {
            continue;
          }
          if (Array.isArray(node)) {
            stack.push(...node);
            continue;
          }
          counts.objects++;
          if (["Identifier", "Literal", "TemplateElement"].includes(node.type)) {
            counts.leaves++;
            for (const child of Object.values(node)) {
              if (child && typeof child === "object") {
                counts.leafMetadata++;
              }
            }
          }
          for (const key of Object.keys(node)) {
            if (["start", "end", "loc", "range"].includes(key)) {
              continue;
            }
            const child = node[key];
            if (child && typeof child === "object") {
              stack.push(child);
            }
          }
        }
      },
    );
  }
  console.log(JSON.stringify({ event: "counts", ...counts }));
  for (const cache of ["cold", "warm"]) {
    for (const arm of ["baseline", "candidate"]) {
      const rows = records.filter((r) => r.cache === cache && r.arm === arm);
      const summarize = (key) => {
        const sorted = rows.map((r) => r[key]).toSorted((a, b) => a - b);
        return {
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        };
      };
      console.log(
        JSON.stringify({
          event: "summary",
          arm,
          cache,
          samples: rows.length,
          seconds: summarize("seconds"),
          cpuSeconds: summarize("cpuSeconds"),
          maxRssMiB: summarize("maxRssMiB"),
        }),
      );
    }
  }
} finally {
  fs.rmSync(baselinePath);
  fs.rmSync(temporary, { recursive: true, force: true });
}
