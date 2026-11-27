/**
 * Pending workspace manifest retention, using the real recovery/tree-input owners.
 * Node 26: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-manifest-retention.ts <scratch> [prepare|recovery|owner] [files=80000]
 * Prepare once, then run baseline/candidate in fresh processes, alternating five
 * times. Use identical CPU/memory limits. Synthetic files only; scratch must be
 * task-owned. Reports forced-GC memory counters, process peak RSS, and output
 * hashes. queueMs includes input creation and GC; elapsedMs includes deliberate
 * blocking and GC, so neither is production latency. arrayBuffers can still
 * count transferred backing stores; use external and detachment alongside it.
 * For untraced recovery latency, use mode latency without --expose-gc. It warms
 * worker startup, then times the same recovery workload without blockers, GC,
 * encoder instrumentation, or sampling. Run five fresh-process alternating
 * baseline/candidate pairs; report elapsedMs median and mean plus host load.
 * Hash memo census: hash-prepare creates 18,000-byte files (62,000 = 1.116 GB).
 * hash-count/hash-alloc measure three unchanged computation-owner captures after
 * a real worker-hash warmup. Run five alternating fresh processes per source and
 * separate A/A controls. Hash counts times the fixed file size are logical bytes;
 * Linux /proc/self/io reports physical process bytes (including libuv threads).
 * Allocation sampling is a separate run; filesystem cache is uncontrolled unless
 * argument 6 is "cold", which evicts only this Linux fixture before each capture.
 * Argument 5 pins the hash-memo owner to a Git revision ("current" uses the worktree).
 * Argument 7 labels a fresh-process arm (for example A1, B, or A2).
 * hash-profile writes separate main-isolate CPU profiles beside the fixture;
 * native fs-safe/libuv hashing CPU is included only in the process CPU counter.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { WorkerWorkspaceManifestEntry } from "../../src/gateway/worker-environments/workspace-manifest.js";
import { resolveWorkerPoolSize } from "../../src/infra/worker-pool-sizing.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import {
  drainGlobalSingletonLifecycleState,
  readGlobalSingleton,
} from "../../src/shared/global-singleton.js";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const scratch = path.resolve(process.argv[2]!);
const mode = process.argv[3] ?? "recovery";
const count = Number(process.argv[4] ?? 80_000);
const revision = process.argv[5];
const cold = process.argv[6] === "cold";
const ownerPath = "src/gateway/worker-environments/workspace-hash-memo.ts";
const source =
  revision && revision !== "current"
    ? execFileSync("git", ["show", `${revision}:${ownerPath}`], { encoding: "utf8" })
    : readFileSync(ownerPath, "utf8");
if (revision && revision !== "current") {
  const ownerUrl = pathToFileURL(path.resolve(ownerPath)).href;
  registerHooks({
    load(url, context, nextLoad) {
      return url === ownerUrl
        ? { source, format: "module-typescript", shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const { computeWorkspaceManifest, prepareWorkspaceTreeInput, serializeWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest-worker.js");
const { createWorkspacePatch } =
  await import("../../src/gateway/worker-environments/workspace-reconcile-recovery.js");
assert.ok(Number.isSafeInteger(count) && count > 0);
assert.ok(
  [
    "prepare",
    "recovery",
    "owner",
    "latency",
    "hash-prepare",
    "hash-count",
    "hash-alloc",
    "hash-profile",
  ].includes(mode),
);
const root = path.join(scratch, "files");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const filename = (index: number) =>
  `${String(Math.floor(index / 1000)).padStart(3, "0")}/${String(index).padStart(6, "0")}-${"synthetic".repeat(8)}.txt`;
function entries(): WorkerWorkspaceManifestEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: filename(index),
    type: "file",
    mode: 0o644,
    size: 0,
    sha256: digest(""),
  }));
}
if (mode === "prepare" || mode === "hash-prepare") {
  const content = mode === "hash-prepare" ? Buffer.alloc(18_000, 65) : "";
  await fs.mkdir(root, { recursive: true });
  for (let index = 0; index < count; index++) {
    if (index % 1000 === 0) {
      await fs.mkdir(path.dirname(path.join(root, filename(index))), { recursive: true });
    }
    await fs.writeFile(path.join(root, filename(index)), content, { mode: 0o644 });
  }
  console.log(JSON.stringify({ prepared: count, bytes: count * content.length }));
} else if (mode === "hash-count" || mode === "hash-alloc" || mode === "hash-profile") {
  const { Session } = await import("node:inspector/promises");
  const { loadavg } = await import("node:os");
  const { readActualWorkspaceManifestImpl } =
    await import("../../src/gateway/worker-environments/workspace-actual-manifest.js");
  const { executeWorkspaceManifestComputation } =
    await import("../../src/gateway/worker-environments/workspace-manifest-computation.runtime.js");
  const { serializeRemoteWorkspaceHashMemo, withWorkerWorkspaceHashMemo, pruneWorkspaceHashMemo } =
    await import("../../src/gateway/worker-environments/workspace-hash-memo.js");
  const hashes = new Map<string, string>();
  const first = await withWorkerWorkspaceHashMemo(hashes, () =>
    readActualWorkspaceManifestImpl({ root, baseCommit: null }),
  );
  assert.equal(first.manifest.entries.length, count);
  assert(first.manifest.entries.every((entry) => entry.type === "file" && entry.size === 18_000));
  const memo = new Map<string, string>(JSON.parse(serializeRemoteWorkspaceHashMemo(hashes)));
  const workerHashes = memo.size;
  hashes.clear();
  const physicalReadBytes = async () => {
    if (process.platform !== "linux") {
      return undefined;
    }
    const contents = await fs.readFile("/proc/self/io", "utf8");
    return Number(/^read_bytes: (\d+)$/mu.exec(contents)?.[1]);
  };
  const inspector = mode !== "hash-count" ? new Session() : undefined;
  inspector?.connect();
  if (mode === "hash-profile") {
    await inspector!.post("Profiler.enable");
  }
  try {
    for (let index = 0; index < 3; index++) {
      if (cold) {
        assert.equal(process.platform, "linux", "Cold reads require Linux posix_fadvise");
        execFileSync("python3", [
          "-c",
          "import os,sys\nfor directory,_,names in os.walk(sys.argv[1]):\n for name in names:\n  fd=os.open(os.path.join(directory,name),os.O_RDONLY)\n  try:\n   os.fsync(fd)\n   os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED)\n  finally: os.close(fd)",
          root,
        ]);
      }
      global.gc?.();
      if (mode === "hash-alloc") {
        await inspector!.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      } else if (mode === "hash-profile") {
        await inspector!.post("Profiler.start");
      }
      const readsBefore = await physicalReadBytes();
      const cpuBefore = process.cpuUsage();
      const start = performance.now();
      pruneWorkspaceHashMemo(memo);
      const result = await executeWorkspaceManifestComputation({
        type: "workspace.manifest.reference",
        input: {
          payload: new TextEncoder().encode(
            JSON.stringify({
              root,
              baseCommit: null,
              hashes: { owner: "gateway", entries: [...memo] },
            }),
          ),
        },
      });
      for (const [identity, sha256] of result.hashes) {
        memo.set(identity, sha256);
      }
      pruneWorkspaceHashMemo(memo);
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(cpuBefore);
      const readsAfter = await physicalReadBytes();
      const allocation =
        mode === "hash-alloc" ? await inspector!.post("HeapProfiler.stopSampling") : undefined;
      const profile = mode === "hash-profile" ? await inspector!.post("Profiler.stop") : undefined;
      const profilePath = profile
        ? path.join(scratch, `${process.argv[7] ?? "hash"}-${index}.cpuprofile`)
        : undefined;
      if (profilePath && profile) {
        await fs.writeFile(profilePath, JSON.stringify(profile.profile));
      }
      assert.equal(result.value, first.manifestRef);
      console.log(
        JSON.stringify({
          mode,
          label: process.argv[7],
          revision: revision ?? "current",
          sourceSha256: digest(source),
          cold,
          index,
          count,
          workerHashes,
          retainedHashes: memo.size,
          ...result.metrics,
          contentReadBytes: result.metrics.contentHashCount * 18_000,
          physicalReadBytes:
            readsBefore === undefined || readsAfter === undefined
              ? undefined
              : readsAfter - readsBefore,
          cpuMs: (cpu.user + cpu.system) / 1000,
          elapsedMs,
          allocationBytes: allocation ? sumSampledHeapBytes(allocation.profile.head) : undefined,
          profilePath,
          manifestRef: result.value,
          load: loadavg(),
        }),
      );
    }
  } finally {
    inspector?.disconnect();
    await drainGlobalSingletonLifecycleState();
  }
} else if (mode === "latency") {
  try {
    await serializeWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
    const start = performance.now();
    const output = await createWorkspacePatch({
      root,
      stagingRoot: root,
      baseEntries: entries(),
      appliedEntries: entries(),
    });
    const elapsedMs = performance.now() - start;
    console.log(
      JSON.stringify({
        mode,
        count,
        node: process.version,
        elapsedMs,
        result: {
          baseTree: output.baseTree,
          patchBytes: output.patch.byteLength,
          patchSha256: digest(output.patch),
          packSha256: digest(output.basePack),
        },
      }),
    );
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
} else {
  assert.ok(global.gc, "requires --expose-gc");
  const release = createDeferredCore();
  let entered = 0;
  const blockers: Promise<unknown>[] = [];
  const slots = resolveWorkerPoolSize("compute");
  const OriginalTextEncoder = globalThis.TextEncoder;
  let payload: WeakRef<Uint8Array> | undefined;
  let payloadBytes = 0;
  globalThis.TextEncoder = class extends OriginalTextEncoder {
    override encode(input?: string) {
      const bytes = super.encode(input);
      if (bytes.byteLength > 1_000_000) {
        payload = new WeakRef(bytes);
        payloadBytes = bytes.byteLength;
      }
      return bytes;
    }
  };
  const waitFor = async (condition: () => boolean) => {
    const deadline = performance.now() + 120_000;
    while (!condition()) {
      assert.ok(performance.now() < deadline, "pending phase did not arrive");
      await setTimeout(10);
    }
  };
  const memory = async () => {
    for (let i = 0; i < 4; i++) {
      await setImmediate();
      global.gc!();
    }
    const { heapUsed, arrayBuffers, external, rss } = process.memoryUsage();
    return { heapUsed, arrayBuffers, external, rss };
  };
  const runtime = () =>
    readGlobalSingleton(Symbol.for("openclaw.gitOperations")) as {
      pending: Set<Promise<unknown>>;
      workspace: { getSnapshot(): unknown };
    };
  let completion: Promise<unknown> | undefined;
  try {
    for (let index = 0; index < slots; index++) {
      blockers.push(
        computeWorkspaceManifest(
          {
            type: "workspace.manifest.tree-input",
            input: {
              payload: new OriginalTextEncoder().encode(
                JSON.stringify({
                  inputPath: path.join(scratch, `blocker-${index}`),
                  ref: "refs/heads/blocker",
                  entries: [
                    { type: "file", path: "blocker.txt", mode: 0o644, size: 0, sha256: digest("") },
                  ],
                  source: { root, tree: "a".repeat(40) },
                }),
              ),
            },
          },
          undefined,
          {
            text: async () => {
              throw new Error("Unexpected text request");
            },
            buffered: async (_cwd, args) => {
              const listing = args.includes("ls-tree");
              if (!listing) {
                entered++;
                await release.promise;
              }
              return {
                stdout: listing
                  ? Buffer.from(`100644 blob ${"b".repeat(40)}\tblocker.txt\0`)
                  : Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                code: 0,
                signal: null,
                killed: false,
                termination: "exit",
              };
            },
          },
        ),
      );
    }
    await waitFor(() => entered === slots);
    const before = await memory();
    const start = performance.now();
    let settled = false;
    const outputPath = path.join(scratch, "owner-input");
    completion =
      mode === "recovery"
        ? createWorkspacePatch({
            root,
            stagingRoot: root,
            baseEntries: entries(),
            appliedEntries: entries(),
          })
        : prepareWorkspaceTreeInput({
            inputPath: outputPath,
            ref: "refs/heads/synthetic",
            entries: entries(),
            source: { root },
          });
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => runtime().pending.size === slots + 1 || settled);
    assert.equal(settled, false);
    const queued = await memory();
    const queuedPool = runtime().workspace.getSnapshot();
    const queueMs = performance.now() - start;
    release.resolve();
    await Promise.all(blockers);
    // Admission has transferred the caller buffer already. Give the worker a
    // turn to start the large streamed write, then observe while still pending.
    await setTimeout(100);
    assert.equal(settled, false, "fixture too small for active observation");
    const active = await memory();
    const activePool = runtime().workspace.getSnapshot();
    const output = await completion;
    const elapsedMs = performance.now() - start;
    const result =
      mode === "recovery"
        ? (() => {
            const value = output as Awaited<ReturnType<typeof createWorkspacePatch>>;
            return {
              baseTree: value.baseTree,
              patchBytes: value.patch.byteLength,
              patchSha256: digest(value.patch),
              packSha256: digest(value.basePack),
            };
          })()
        : { inputSha256: digest(await fs.readFile(outputPath)) };
    const after = await memory();
    console.log(
      JSON.stringify({
        mode,
        count,
        slots,
        node: process.version,
        payloadBytes,
        originalPayloadBytes: payload?.deref()?.byteLength ?? 0,
        before,
        queued,
        active,
        after,
        queueMs,
        elapsedMs,
        maxRssKiB: process.resourceUsage().maxRSS,
        queuedPool,
        activePool,
        result,
      }),
    );
  } finally {
    release.resolve();
    await Promise.allSettled([...blockers, ...(completion ? [completion] : [])]);
    globalThis.TextEncoder = OriginalTextEncoder;
    await drainGlobalSingletonLifecycleState();
    for (let index = 0; index < slots; index++) {
      await fs.rm(path.join(scratch, `blocker-${index}`), { force: true });
    }
    await fs.rm(path.join(scratch, "owner-input"), { force: true });
  }
}
