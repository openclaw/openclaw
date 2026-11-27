/** Exact resolver owner benchmark; registry transport is a fixed synthetic boundary.
 * node --expose-gc scripts/perf/worktree-path-resolve-measure.mjs --base <sha> --output <fresh-dir>
 * 800 real directories, 5 counterbalanced A1/A2/B arms, separate timing/allocation.
 * Does not measure registry SQL/transport or full agent turns; directory contents are unread.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";

const { values } = parseArgs({ options: { base: { type: "string" }, output: { type: "string" } } });
assert(values.base && values.output && global.gc, "Supply --base, fresh --output and --expose-gc");
const output = path.resolve(values.output);
await fs.mkdir(output);
const fixture = await fs.mkdtemp(path.join(output, "fixture-"));
const root = await fs.realpath(fixture);
const files = ["src/agents/worktrees/run-lease.ts", "src/infra/path-existence.ts"];
const base = execFileSync("git", ["rev-parse", `${values.base}^{commit}`], {
  encoding: "utf8",
}).trim();
const sources = {};
for (const label of ["A", "B"]) {
  sources[label] = {};
  for (const file of files) {
    sources[label][file] =
      label === "A"
        ? execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8" })
        : await fs.readFile(file, "utf8");
  }
}
await fs.writeFile(path.join(output, "sources.json"), JSON.stringify({ base, sources }));
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = end ? source.indexOf(end, first) : source.length;
  assert(first >= 0 && last > first && source.indexOf(start, first + 1) === -1);
  return source.slice(first, last).replace(/^export /gm, "");
}
let realpaths = 0;
const records = [];
const context = { environment: {}, admission: { assertCurrent() {} } };
function load(source) {
  const canonicalize = compileFunction(
    `${stripTypeScriptTypes(
      section(
        source[files[1]],
        "export async function realpathOrResolve",
        "/** Resolve an absolute path",
      ),
    )}\nreturn realpathOrResolve;`,
    ["fsPromises", "path"],
  )(
    {
      realpath: async (value) => {
        realpaths++;
        return fs.realpath(value);
      },
    },
    path,
  );
  return compileFunction(
    `${stripTypeScriptTypes(
      section(
        source[files[0]],
        "export async function resolveWorktreeForPath",
        "async function deleteRunLeaseRowWithRetries",
      ),
    )}\nreturn resolveWorktreeForPath;`,
    [
      "path",
      "realpathOrResolve",
      "captureOpenClawStateWorkerContext",
      "readRegistryWorktree",
      "readRegistryWorktrees",
    ],
  )(
    path,
    canonicalize,
    () => context,
    async (_context, id) => records.find((record) => record.id === id),
    async () => records.filter((record) => record.removedAt === undefined),
  );
}
const owners = { A: load(sources.A), B: load(sources.B) };
const operations = 40;
const results = [];
const sumBytes = (node) =>
  node.selfSize + node.children.reduce((sum, child) => sum + sumBytes(child), 0);
try {
  for (let index = 0; index < 800; index++) {
    const directory = path.join(root, "worktrees", "synthetic-repository", `checkout-${index}`);
    await fs.mkdir(directory, { recursive: true });
    records.push({ id: String(index), path: directory });
  }
  const nested = path.join(records[799].path, "src", "nested");
  await fs.mkdir(nested, { recursive: true });
  const alias = path.join(root, "cwd-alias");
  await fs.symlink(nested, alias, process.platform === "win32" ? "junction" : "dir");
  const cases = [
    [alias, "799"],
    [nested, "799"],
    [records[799].path, "799"],
    [`${records[799].path}-sibling`, undefined],
  ];
  for (const resolve of Object.values(owners)) {
    for (const [candidate, expected] of cases) {
      assert.equal(
        (await resolve({ candidatePaths: [candidate, candidate] }))?.record.id,
        expected,
      );
    }
    records[799].removedAt = 1;
    assert.equal(await resolve({ candidatePaths: [nested] }), undefined);
    await assert.rejects(
      resolve({ sessionEntry: { worktree: { id: "799" } }, candidatePaths: [alias] }),
      /managed worktree was removed/,
    );
    delete records[799].removedAt;
  }
  // Overlapping custom storage roots keep registry precedence, not nearest-root precedence.
  records.unshift({ id: "outer", path: path.dirname(records[0].path) });
  for (const resolve of Object.values(owners)) {
    assert.equal((await resolve({ candidatePaths: [nested] }))?.record.id, "outer");
  }
  records.shift();
  for (const mode of ["timing", "allocation", "profile"]) {
    for (let sample = 0; sample < (mode === "profile" ? 1 : 5); sample++) {
      for (const arm of sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"]) {
        const resolve = owners[arm === "B" ? "B" : "A"];
        for (let warm = 0; warm < 5; warm++) {
          await resolve({ candidatePaths: [alias] });
        }
        global.gc();
        const inspector = new Session();
        if (mode !== "timing") {
          inspector.connect();
        }
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        if (mode === "profile") {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
        }
        realpaths = 0;
        const hostLoad = loadavg();
        const cpu = process.cpuUsage();
        const thread = process.threadCpuUsage();
        const timings = [];
        for (let iteration = 0; iteration < operations; iteration++) {
          const start = performance.now();
          const selected = await resolve({ candidatePaths: [iteration % 2 ? alias : cases[3][0]] });
          timings.push(performance.now() - start);
          assert.equal(selected?.record.id, iteration % 2 ? "799" : undefined);
        }
        const usedCpu = process.cpuUsage(cpu);
        const usedThread = process.threadCpuUsage(thread);
        assert.equal(realpaths, operations * (arm === "B" ? 1 : 801));
        let allocationBytes;
        if (mode === "allocation") {
          allocationBytes =
            sumBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head) / operations;
        }
        if (mode === "profile") {
          await fs.writeFile(
            path.join(output, `${arm}.cpuprofile`),
            JSON.stringify((await inspector.post("Profiler.stop")).profile),
          );
        }
        inspector.disconnect();
        timings.sort((a, b) => a - b);
        const result = {
          mode,
          sample,
          arm,
          operations,
          realpathsPerResolve: realpaths / operations,
          cpuMs: (usedCpu.user + usedCpu.system) / 1000 / operations,
          threadCpuMs: (usedThread.user + usedThread.system) / 1000 / operations,
          medianMs: timings[Math.ceil(operations * 0.5) - 1],
          p95Ms: timings[Math.ceil(operations * 0.95) - 1],
          allocationBytes,
          load: hostLoad,
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  }
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        base,
        node: process.version,
        platform: process.platform,
        records: records.length,
        results,
        hashes: Object.fromEntries(
          Object.entries(sources).map(([arm, source]) => [
            arm,
            Object.fromEntries(
              Object.entries(source).map(([file, text]) => [
                file,
                createHash("sha256").update(text).digest("hex"),
              ]),
            ),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
