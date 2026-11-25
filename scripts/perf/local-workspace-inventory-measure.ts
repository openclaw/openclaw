/**
 * Frozen-owner inventory allocation/CPU proof; never contacts a Gateway or agent database.
 * node scripts/perf/local-workspace-inventory-measure.ts --prepare .local/lane2195/proof --base-ref HEAD
 * node scripts/perf/local-workspace-inventory-measure.ts --fixture .local/lane2195/workspace
 * node scripts/perf/local-workspace-inventory-measure.ts --compare .local/lane2195/proof --fixture .local/lane2195/workspace > .local/lane2195/ab.json
 * Repeat comparison with --control for A/A. --allocation records separate sampled allocation.
 * Default fixture: 62,000 real sparse files, 1.143 GB logical, real Git index and snapshot.
 * Files have identical zero bytes; index/ls-tree work depends on names, not blob diversity.
 * Warm filesystem caches, five counterbalanced process pairs, ten warm calls per operation.
 * Acceptance: identical inventories and custody updates, lower allocation/CPU per call;
 * investigate >=20% timing/CPU regressions with A/A controls. Report first-owner separately.
 * Main-thread/process CPU excludes Git children. This is owner proof, not full-turn latency,
 * btrfs qualification, or 35 GiB agent-database proof (this owner does not read that database).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type {
  prepareLocalWorkspaceBuildInputs,
  selectLocalWorkspaceCanonicalPaths,
} from "../../src/gateway/worker-environments/local-workspace-inventory.js";

const { values } = parseArgs({
  options: {
    prepare: { type: "string" },
    "base-ref": { type: "string", default: "HEAD" },
    fixture: { type: "string" },
    compare: { type: "string" },
    sample: { type: "string" },
    control: { type: "boolean" },
    allocation: { type: "boolean" },
    files: { type: "string", default: "62000" },
    samples: { type: "string", default: "5" },
    calls: { type: "string", default: "10" },
    "cache-files": { type: "string", default: "2000" },
  },
});
const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../..");
const owner = "src/gateway/worker-environments/local-workspace-inventory.ts";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const environment = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const git = (root: string, args: string[], input?: string | Buffer) =>
  execFileSync("git", ["-C", root, ...args], {
    input,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
const integer = (value: string, minimum: number) => {
  const result = Number(value);
  assert(Number.isSafeInteger(result) && result >= minimum);
  return result;
};

if (values.prepare) {
  const directory = path.resolve(values.prepare);
  fs.mkdirSync(directory);
  const { build } = await import("esbuild");
  const sources = {
    before: execFileSync("git", ["show", `${values["base-ref"]}:${owner}`], {
      cwd: repository,
      encoding: "utf8",
    }),
    after: fs.readFileSync(path.join(repository, owner), "utf8"),
  };
  for (const [arm, contents] of Object.entries(sources)) {
    await build({
      absWorkingDir: repository,
      entryPoints: [owner],
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["*.node"],
      define: { WORKER_DEPLOY_BUILD: "false" },
      logLevel: "warning",
      banner: {
        js: 'import {createRequire as __createRequire} from "node:module"; const require = __createRequire(import.meta.url);',
      },
      plugins: [
        {
          name: "frozen-inventory-owner",
          setup(builder) {
            builder.onLoad({ filter: /\/local-workspace-inventory\.ts$/ }, () => ({
              contents,
              loader: "ts",
              resolveDir: path.dirname(path.join(repository, owner)),
            }));
          },
        },
      ],
      outfile: path.join(directory, `${arm}.mjs`),
    });
  }
  const provenance = {
    baseCommit: git(repository, ["rev-parse", values["base-ref"]]),
    sourceHashes: Object.fromEntries(
      Object.entries(sources).map(([arm, source]) => [arm, hash(source)]),
    ),
    bundleHashes: Object.fromEntries(
      Object.keys(sources).map((arm) => [
        arm,
        hash(fs.readFileSync(path.join(directory, `${arm}.mjs`))),
      ]),
    ),
  };
  fs.writeFileSync(path.join(directory, "source.json"), JSON.stringify(provenance));
  console.log(JSON.stringify(provenance));
} else if (values.fixture && !values.compare && !values.sample) {
  const root = path.resolve(values.fixture),
    count = integer(values.files, 10),
    bytes = 18_432;
  const cacheFiles = Math.min(count, integer(values["cache-files"], 0));
  fs.mkdirSync(root);
  git(root, ["init", "--quiet"]);
  const blob = git(root, ["hash-object", "-w", "--stdin"], Buffer.alloc(bytes));
  const entries: string[] = [];
  for (let index = 0; index < count; index++) {
    const prefix = index < cacheFiles ? ".artifacts/build-cache-inputs" : "source";
    const relative = `${prefix}/package-${Math.floor(index / 100)}/src/deep/modules/file-${index}.ts`;
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    const descriptor = fs.openSync(path.join(root, relative), "wx");
    fs.ftruncateSync(descriptor, bytes);
    fs.closeSync(descriptor);
    entries.push(`100644 ${blob}\t${relative}\0`);
  }
  git(root, ["update-index", "-z", "--index-info"], entries.join(""));
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "synthetic sparse inventory",
  ]);
  console.log(
    JSON.stringify({ root, files: count, cacheFiles, logicalBytes: count * bytes, sparse: true }),
  );
} else if (values.compare) {
  assert(values.fixture);
  const rows = [];
  for (let sample = 0; sample < integer(values.samples, 5); sample++) {
    for (const arm of sample % 2 ? ["after", "before"] : ["before", "after"]) {
      const output = execFileSync(
        process.execPath,
        [
          script,
          "--sample",
          path.resolve(values.compare, `${values.control ? "before" : arm}.mjs`),
          "--fixture",
          path.resolve(values.fixture),
          "--calls",
          values.calls,
          ...(values.allocation ? ["--allocation"] : []),
        ],
        { env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      rows.push({ arm, sample, result: JSON.parse(output) });
      console.error(
        `completed ${values.control ? "A/A" : "A/B"} ${sample + 1}/${values.samples} ${arm}`,
      );
    }
  }
  const signature = (row: { digest: string; retentionWrites: number }) => [
    row.digest,
    row.retentionWrites,
  ];
  let expected: ReturnType<typeof signature>[] | undefined;
  for (const row of rows) {
    const actual = row.result.rows.map(signature);
    expected ??= actual;
    assert.deepEqual(actual, expected);
  }
  console.log(
    JSON.stringify({
      control: Boolean(values.control),
      allocation: Boolean(values.allocation),
      provenance: JSON.parse(fs.readFileSync(path.join(values.compare, "source.json"), "utf8")),
      rows,
    }),
  );
} else if (values.sample) {
  assert(values.fixture);
  assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26.12+");
  const root = path.resolve(values.fixture),
    calls = integer(values.calls, 1);
  const runtime: {
    prepareLocalWorkspaceBuildInputs: typeof prepareLocalWorkspaceBuildInputs;
    selectLocalWorkspaceCanonicalPaths: typeof selectLocalWorkspaceCanonicalPaths;
  } = await import(pathToFileURL(path.resolve(values.sample)).href);
  const admission = JSON.stringify(
    git(root, ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean),
  );
  const preparedPaths = new Set<string>(JSON.parse(admission));
  const snapshotRef = git(root, ["rev-parse", "HEAD"]);
  const inspector = values.allocation ? new Session() : undefined;
  inspector?.connect();
  const rows = [];
  try {
    for (const operation of ["live", "snapshot", "prepared"] as const) {
      const projection = { source_paths_json: admission, baseline_ref: "synthetic-baseline" };
      let writes = 0;
      const invoke = async () =>
        operation === "prepared"
          ? {
              paths: await runtime.selectLocalWorkspaceCanonicalPaths({
                root,
                preparedPaths,
                assertCurrent() {},
              }),
              retained: [],
            }
          : runtime.prepareLocalWorkspaceBuildInputs({
              worktree: {
                path: root,
                repoRoot: root,
                ...(operation === "snapshot" ? { snapshotRef } : {}),
              },
              projection,
              signal: new AbortController().signal,
              assertCurrent() {},
              retainSourcePaths: async (sourcePaths) => {
                projection.source_paths_json = sourcePaths;
                writes++;
              },
            });
      for (const phase of ["first-owner", "warm"] as const) {
        const repetitions = phase === "warm" ? calls : 1;
        const previousWrites = writes;
        if (inspector) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const allocated = getHeapStatistics().total_allocated_bytes;
        const processCpu = process.cpuUsage(),
          threadCpu = process.threadCpuUsage(),
          start = performance.now();
        let result: Awaited<ReturnType<typeof invoke>> | undefined;
        for (let index = 0; index < repetitions; index++) {
          result = await invoke();
        }
        const wallMs = (performance.now() - start) / repetitions;
        const threadDelta = process.threadCpuUsage(threadCpu),
          cpuDelta = process.cpuUsage(processCpu);
        const allocatedBytes =
          (getHeapStatistics().total_allocated_bytes - allocated) / repetitions;
        const profile = inspector
          ? (await inspector.post("HeapProfiler.stopSampling")).profile
          : undefined;
        assert(result);
        const digest = hash(
          JSON.stringify({
            paths: [...result.paths].toSorted((left, right) => left.localeCompare(right)),
            retained: result.retained.toSorted((left, right) => left.localeCompare(right)),
            admission: projection.source_paths_json,
          }),
        );
        rows.push({
          operation,
          phase,
          calls: repetitions,
          wallMs,
          allocatedBytes,
          threadCpuMs: (threadDelta.user + threadDelta.system) / 1000 / repetitions,
          processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000 / repetitions,
          sampledBytes: profile
            ? profile.samples.reduce((total, sample) => total + sample.size, 0) / repetitions
            : undefined,
          retentionWrites: writes - previousWrites,
          paths: result.paths.size,
          digest,
        });
        if (phase === "warm") {
          assert.equal(writes, previousWrites);
        }
      }
    }
  } finally {
    inspector?.disconnect();
  }
  console.log(
    JSON.stringify({ node: process.version, platform: process.platform, load: os.loadavg(), rows }),
  );
} else {
  throw new Error("Select --prepare, --fixture, --compare or --sample; see script header");
}
