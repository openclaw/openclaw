/**
 * Measure local-workspace writer payloads through the real store and SQLite broker.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-request-bytes-measure.ts
 *   --output .local/workspace-bytes-candidate --instrument bytes --iterations 32 --paths 1000
 * Add --revision <base-sha> to substitute that revision's store and publication owners.
 * For worker codec changes, execute in complete frozen revisions instead: --revision
 * substitutes host owners only and does not replace worker entrypoints.
 * Run --instrument timing and allocation separately, in fresh AB/BA processes;
 * those modes do not serialize requests a second time to count their bytes.
 * Each cycle admits source paths, reserves a checkpoint, accepts its prepared root,
 * and clears its receipt. Roots differ in one file; checkpoint documents retain the
 * full build-input list, as the scan owner does. Sixteen synthetic workspaces rotate.
 * Fingerprints cover every file; acceptance references the saved checkpoint. Compare
 * --paths 30000 --iterations 1024 --workspaces 1 with and without --revision.
 * Reports main-isolate allocation and before/after burst memory without forced GC
 * inside the measured window. This does not measure filesystem scan allocation.
 * MB/min uses the declared --cycles-per-minute rate, not benchmark throughput.
 * This is store-boundary proof: no filesystem reconciliation, Gateway, or Team load.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapSpaceStatistics, getHeapStatistics, serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { transformSync } from "esbuild";
import type {
  LocalWorkspaceManifestCheckpoint,
  LocalWorkspaceProjection,
} from "../../src/gateway/worker-environments/local-workspace-store.types.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    revision: { type: "string" },
    iterations: { type: "string", default: "2048" },
    workspaces: { type: "string", default: "16" },
    paths: { type: "string", default: "1000" },
    instrument: { type: "string", default: "timing" },
    "cycles-per-minute": { type: "string", default: "30" },
  },
});
assert(values.output, "--output must name a new synthetic-state directory");
const instrument = values.instrument!;
assert(["bytes", "timing", "allocation"].includes(instrument));
const iterations = Number(values.iterations);
const workspaceCount = Number(values.workspaces);
const pathCount = Number(values.paths);
const cyclesPerMinute = Number(values["cycles-per-minute"]);
for (const value of [iterations, workspaceCount, pathCount, cyclesPerMinute]) {
  assert(Number.isSafeInteger(value) && value > 0);
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(values.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
for (const name of ["home", "tmp", "state"]) {
  fs.mkdirSync(path.join(output, name));
}
const owner = "src/gateway/worker-environments/local-workspace-store.ts";
const sources = new Map(
  [owner, "src/gateway/worker-environments/local-workspace-publication.ts"].map((file) => [
    file,
    values.revision
      ? execFileSync("git", ["show", `${values.revision}:${file}`], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        })
      : fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
type Phase = "create" | "admission" | "checkpoint" | "settlement" | "cleanup" | "unmeasured";
let phase: Phase = "unmeasured";
const traffic: Partial<
  Record<Phase, Record<string, { requests: number; bytes: number; fields: Record<string, number> }>>
> = {};
type Command = { type: string; input: unknown };
Object.assign(globalThis, {
  __workspaceBytesExecute: (
    scope: { execute: (command: Command) => unknown },
    command: Command,
  ) => {
    if (phase !== "unmeasured") {
      const bucket = (traffic[phase] ??= {});
      const counter = (bucket[command.type] ??= { requests: 0, bytes: 0, fields: {} });
      counter.requests++;
      counter.bytes += serialize(command).byteLength;
      if (command.type === "localWorkspace.mutate" && isRecord(command.input)) {
        const countFields = (prefix: string, record: unknown) => {
          if (isRecord(record)) {
            for (const [key, value] of Object.entries(record)) {
              const field = `${prefix}.${key}`;
              counter.fields[field] = (counter.fields[field] ?? 0) + serialize(value).byteLength;
            }
          }
        };
        countFields("input", command.input);
        const mutation = command.input.mutation;
        if (isRecord(mutation) && !(mutation instanceof Uint8Array)) {
          countFields("mutation", mutation);
          countFields("patch", mutation.patch);
          countFields("row", mutation.row);
          countFields("manifest", mutation.manifest);
          if (isRecord(mutation.patch) && typeof mutation.patch.checkpoint_json === "string") {
            countFields("checkpoint", JSON.parse(mutation.patch.checkpoint_json));
          }
        }
      }
    }
    return scope.execute(command);
  },
});
registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(root, fileURLToPath(url)) : "";
    const source = sources.get(relative);
    if (source === undefined) {
      return nextLoad(url, context);
    }
    const anchor = "scope.execute({";
    if (relative === owner) {
      assert(source.includes(anchor), "Writer instrumentation must match the store owner");
    }
    const code =
      instrument === "bytes" && relative === owner
        ? source.replaceAll(anchor, "globalThis.__workspaceBytesExecute(scope, {")
        : source;
    return {
      format: "module",
      source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const configPath = path.join(output, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(output, "state") },
});
fs.writeFileSync(configPath, JSON.stringify(BASE_GATEWAY_BENCH_CONFIG));
const { withLocalWorkspaceStore } =
  await import("../../src/gateway/worker-environments/local-workspace-store.js");
const { createLocalWorkspaceManifestTree, localWorkspaceManifestRootReference } =
  await import("../../src/gateway/worker-environments/local-workspace-manifest-tree.js");
const { localWorkspaceDigestBytes, prepareLocalWorkspaceTreePacks } =
  await import("../../src/gateway/worker-environments/local-workspace-cas.js");
const { serializeWorkerWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest.js");
const { prepareLocalWorkspaceFingerprints } =
  await import("../../src/gateway/worker-environments/local-workspace-fingerprints.js");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.js");
const { executeOpenClawStateWorker } =
  await import("../../src/state/openclaw-state-worker-store.js");
const { executeExistingOpenClawStateRead } =
  await import("../../src/state/openclaw-state-db-readonly.js");
const state = await import("../../src/state/openclaw-state-db.js");
(await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(
  BASE_GATEWAY_BENCH_CONFIG,
);
state.openOpenClawStateDatabase();
const baseCommit = "a".repeat(40);
const admittedPaths = Array.from(
  { length: pathCount },
  (_, index) => `.artifacts/build-cache-inputs/input-${index}.json`,
);
const directories = [".artifacts", ".artifacts/build-cache-inputs"];
const variants = ["b", "c"].map((content) => {
  const entries = admittedPaths.map((entryPath, index) => ({
    path: entryPath,
    type: "file" as const,
    mode: 0o644,
    size: 4,
    sha256: (index === 0 ? content : "d").repeat(64),
  }));
  const tree = createLocalWorkspaceManifestTree([
    ...directories.map((entryPath) => ({ path: entryPath, type: "directory" as const })),
    ...entries,
  ]);
  const fingerprintScan = prepareLocalWorkspaceFingerprints(
    tree,
    tree.get("")!.treeRef,
    null,
    9e12,
  );
  for (const [index, entry] of entries.entries()) {
    fingerprintScan.observe(
      entry.path,
      `file:1:${index + 100}:4:0:${1_000_000_000_000_000n + BigInt(index) * 982_451_653n}`,
    );
  }
  const fingerprints = fingerprintScan.encode(tree, tree.get("")!.treeRef);
  assert(fingerprints);
  const rawManifest = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit,
    entries: entries.slice(0, 1),
    directories,
    buildCacheInputs: admittedPaths,
  });
  return {
    tree,
    treeRoot: tree.get("")!.treeRef,
    root: localWorkspaceManifestRootReference(tree, baseCommit),
    rawManifest,
    manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
    sourcePaths: JSON.stringify([...admittedPaths, ...directories, `admitted-${content}.txt`]),
    fingerprints: {
      target: "projection" as const,
      blob: fingerprints.toString("base64"),
      oppositeBlob: fingerprints.toString("base64"),
    },
  };
});
const ids = Array.from(
  { length: workspaceCount },
  (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
);
const lastRows = new Map<string, LocalWorkspaceProjection>();
const positions = new Map<string, number>();
let settlementCpuUs = 0;
let settlementAllocatedBytes = 0;
let settlementElapsedMs = 0;
async function cycle(id: string) {
  phase = "unmeasured";
  await withLocalWorkspaceStore({ worktreeId: id }, async (store) => {
    const position = positions.get(id) ?? 0;
    const before = variants[position]!;
    const after = variants[1 - position]!;
    phase = "admission";
    const admitted = await store.update(store.get()!, { source_paths_json: after.sourcePaths });
    assert.equal(admitted.source_paths_json, after.sourcePaths);
    const checkpoint: LocalWorkspaceManifestCheckpoint = {
      version: 1,
      kind: "scan",
      previousRoot: before.root,
      resultingRoot: after.root,
      previousTreeRoot: before.treeRoot,
      treeRoot: after.treeRoot,
      records: [],
      removed: [],
      baseManifestRaw: before.rawManifest,
      baseManifestRef: before.manifestRef,
      currentManifestRaw: after.rawManifest,
      currentManifestRef: after.manifestRef,
      buildCacheInputs: admittedPaths,
      fingerprints: after.fingerprints,
    };
    const checkpointJson = JSON.stringify(checkpoint);
    phase = "checkpoint";
    const reserved = await store.update(admitted, {
      pending_ref: "refs/openclaw/results/synthetic",
      pending_target: "canonical",
      checkpoint_json: checkpointJson,
    });
    phase = "settlement";
    const settlementCpuBefore = process.threadCpuUsage();
    const settlementAllocatedBefore = getHeapStatistics().total_allocated_bytes;
    const settlementStarted = performance.now();
    const accepted = await store.update(reserved, { pending_target: null }, undefined, {
      ...checkpoint,
      fingerprintsFromCheckpoint: true,
    });
    settlementElapsedMs += performance.now() - settlementStarted;
    const settlementCpu = process.threadCpuUsage(settlementCpuBefore);
    settlementCpuUs += settlementCpu.user + settlementCpu.system;
    settlementAllocatedBytes +=
      getHeapStatistics().total_allocated_bytes - settlementAllocatedBefore;
    assert.equal(accepted.checkpoint_json, checkpointJson);
    assert.equal(accepted.baseline_ref, after.root);
    assert.deepEqual(accepted.tree_root_digest, localWorkspaceDigestBytes(after.treeRoot));
    assert.equal(accepted.source_paths_json, after.sourcePaths);
    phase = "cleanup";
    const cleaned = await store.update(accepted, { pending_ref: null, checkpoint_json: null });
    assert.equal(cleaned.pending_ref, null);
    assert.equal(cleaned.checkpoint_json, null);
    lastRows.set(id, cleaned);
    positions.set(id, 1 - position);
    phase = "unmeasured";
  });
}
const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
  node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
try {
  const context = captureOpenClawStateWorkerContext({ env: process.env });
  for (const variant of variants) {
    for (const preparation of prepareLocalWorkspaceTreePacks(variant.tree)) {
      await executeOpenClawStateWorker(context, {
        type: "localWorkspace.prepare",
        input: { preparation },
      });
    }
  }
  phase = "create";
  for (const id of ids) {
    const initial = variants[0]!;
    await withLocalWorkspaceStore({ worktreeId: id }, (store) =>
      store.create({
        worktree_id: id,
        agent_id: "main",
        session_key: `agent:main:workspace:${id}`,
        session_id: id,
        lifecycle_revision: null,
        projection_path: path.join(output, id, "workspace"),
        base_commit: baseCommit,
        source_paths_json: initial.sourcePaths,
        source_paths_digest: null,
        baseline_ref: initial.root,
        tree_root_digest: localWorkspaceDigestBytes(initial.treeRoot),
        baseline_json: null,
        canonical_fingerprints: null,
        projection_fingerprints: null,
        checkpoint_json: null,
        pending_ref: null,
        pending_target: null,
        journal_json: null,
        journal_pack: null,
        paused_runtimes_json: null,
        created_at_ms: 1,
      }),
    );
  }
  await cycle(ids[0]!);
  settlementCpuUs = 0;
  settlementAllocatedBytes = 0;
  settlementElapsedMs = 0;
  for (const bucket of ["admission", "checkpoint", "settlement", "cleanup"] as const) {
    delete traffic[bucket];
  }
  globalThis.gc?.();
  const inspector = instrument === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const spacesBefore = getHeapSpaceStatistics();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const cpuBefore = process.threadCpuUsage();
  const processCpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await cycle(ids[index % workspaceCount]!);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  const memoryAfter = process.memoryUsage();
  const spacesAfter = getHeapSpaceStatistics();
  const sampled = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  for (const [id, expected] of lastRows) {
    const result = await executeExistingOpenClawStateRead(
      { env: process.env },
      { type: "localWorkspace.get", input: { id } },
      { current: true, live: true },
    );
    assert(result?.row);
    assert.deepEqual(
      { ...result.row, rejectedResult: result.row.rejectedResult },
      expected,
      "Durable readback must equal the published projection",
    );
  }
  const report = {
    revision: values.revision ?? "candidate",
    ownerSha256: Object.fromEntries(
      [...sources].map(([file, source]) => [
        file,
        createHash("sha256").update(source).digest("hex"),
      ]),
    ),
    instrument,
    iterations,
    workspaces: workspaceCount,
    admittedFilesPerWorkspace: pathCount,
    cyclesPerMinute,
    traffic: Object.fromEntries(
      Object.entries(traffic).map(([bucket, operations]) => [
        bucket,
        Object.fromEntries(
          Object.entries(operations).map(([operation, counters]) => [
            operation,
            {
              ...counters,
              bytesPerOperation: counters.bytes / counters.requests,
              fieldBytesPerOperation: Object.fromEntries(
                Object.entries(counters.fields).map(([field, bytes]) => [
                  field,
                  bytes / counters.requests,
                ]),
              ),
              mbPerSimulatedMinute:
                bucket === "create" ? null : (counters.bytes * cyclesPerMinute) / iterations / 1e6,
            },
          ]),
        ),
      ]),
    ),
    elapsedMs,
    mainThreadCpuUsPerCycle: instrument === "bytes" ? null : (cpu.user + cpu.system) / iterations,
    processCpuUsPerCycle:
      instrument === "bytes" ? null : (processCpu.user + processCpu.system) / iterations,
    sampledBytesPerCycle: sampled ? allocated(sampled.profile.head) / iterations : null,
    allocatedBytesPerCycle: allocatedBytes / iterations,
    settlement:
      instrument === "bytes"
        ? null
        : {
            mainThreadCpuUsPerOperation: settlementCpuUs / iterations,
            allocatedBytesPerOperation: settlementAllocatedBytes / iterations,
            elapsedMsPerOperation: settlementElapsedMs / iterations,
          },
    hostLoad,
    hostLoadAfter: loadavg(),
    memoryBefore,
    memoryAfter,
    spacesBefore,
    spacesAfter,
    verified: "Source admission, retained checkpoint, accepted root, cleanup, durable readback",
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await state.closeOpenClawStateDatabaseAsync();
  await (await import("../../src/shared/global-singleton.js")).drainGlobalSingletonLifecycleState();
}
