/**
 * Measure the real session replacement transaction on synthetic, isolated state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-replacement-write-measure.ts
 *   --output .local/buf464/base.json --owner-dir .local/buf464/base
 * Omit --owner-dir for the candidate. The sparse overlay uses the existing worker
 * benchmark loader; preserve the baseline replacement-state.ts at its source path.
 * Defaults: 10,000 sessions, 1,000 changed rows per transaction, five transactions
 * per timing/allocation pass. Preparation and durable readback are outside timing.
 * --snapshot-repeats controls saved prompt size (128 by default; 2048 is 62 KiB).
 * This runs the native writer owner in this isolate, including COMMIT; it excludes
 * worker transport, Gateway activity and queue wait. Five transaction samples do
 * not qualify a latency percentile. Allocation sampling is a separate pass.
 * --mode worker instead sends each replacement followed by three prepareWrite
 * neighbors through the real shared writer. It reports execute and queue timing;
 * CPU/allocation in that mode do not describe the worker and are omitted.
 * --mode metadata --batch 4 --passes 200 --hold-ms 20 measures committed metadata
 * preparation and patch completion under real concurrent writes. Repeat with --allocation
 * for main-isolate sampled allocation; --targets-per-patch 4 measures atomic batches.
 * Use --owner-dir for a sparse pristine baseline
 * of replacement-{projection,read,state,types,worker}.ts, and compare output hashes.
 * Commit retains the complete entry publication contract; no transcript is restored.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { SamplingProfile } from "../../src/logging/diagnostic-heap-profile.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "owner-dir": { type: "string" },
    sessions: { type: "string", default: "10000" },
    batch: { type: "string", default: "1000" },
    passes: { type: "string", default: "5" },
    "snapshot-repeats": { type: "string", default: "128" },
    profile: { type: "boolean", default: false },
    mode: { type: "string", default: "owner" },
    "hold-ms": { type: "string", default: "20" },
    "targets-per-patch": { type: "string", default: "1" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
const sessions = Number(values.sessions);
const batch = Number(values.batch);
const passes = Number(values.passes);
const snapshotRepeats = Number(values["snapshot-repeats"]);
const targetsPerPatch = Number(values["targets-per-patch"]);
assert([sessions, batch, passes, snapshotRepeats].every((n) => Number.isSafeInteger(n) && n > 0));
assert(batch <= sessions);
assert(["owner", "worker", "metadata"].includes(values.mode));
if (values.mode === "metadata") {
  assert(Number.isSafeInteger(targetsPerPatch) && targetsPerPatch > 0);
  assert(sessions >= 2 && batch * targetsPerPatch <= Math.min(sessions - 1, 128));
}
const output = path.resolve(values.output);
const ownerSource = values["owner-dir"]
  ? path.join(
      path.resolve(values["owner-dir"]),
      "src/config/sessions/session-accessor.sqlite-replacement-state.ts",
    )
  : new URL(
      "../../src/config/sessions/session-accessor.sqlite-replacement-state.ts",
      import.meta.url,
    );
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerSource))
  .digest("hex");
await mkdir(path.dirname(output), { recursive: true });
const tmpdir = path.join(path.dirname(output), "tmp");
await mkdir(tmpdir, { recursive: true });
process.env.TMPDIR = tmpdir;
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const [{ withOpenClawTestState }, agent, entries, reads, owner, worker, diagnostics] =
  await Promise.all([
    import("../../src/test-utils/openclaw-test-state.ts"),
    import("../../src/state/openclaw-agent-db.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-replacement-read.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-replacement-state.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-replacement-worker.ts"),
    import("../../src/infra/worker-request-diagnostics.ts"),
  ]);
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = agent.openOpenClawAgentDatabase({ agentId: "main", env });
    const options = { agentId: "main", path: database.path, env };
    const key = (index: number) => `agent:main:synthetic-write-${index}`;
    const initial = (index: number): InternalSessionEntry => ({
      sessionId: `synthetic-write-${index}`,
      updatedAt: 1000,
      label: `Synthetic completed task ${index}`,
      delivery: { kind: "none" },
      ...(values.mode === "metadata"
        ? {
            archivedAt: 900,
            archiveReason: "manual" as const,
            sessionDiffBaseline: {
              version: 1 as const,
              sessionId: `synthetic-write-${index}`,
              root: "/synthetic",
              files: Array.from({ length: 100 }, (_, file) => ({
                path: `file-${file}.ts`,
                fingerprint: "a".repeat(64),
              })),
            },
          }
        : {}),
      skillsSnapshot: {
        prompt: "Synthetic saved skill context. ".repeat(snapshotRepeats),
        skills: [],
      },
      pluginExtensions:
        values.mode === "metadata"
          ? Object.fromEntries(
              Array.from({ length: 40 }, (_, pluginIndex) => [
                `synthetic-${pluginIndex}`,
                { payload: "Synthetic plugin state. ".repeat(2) },
              ]),
            )
          : { synthetic: { payload: "Synthetic plugin state. ".repeat(32) } },
    });
    agent.runOpenClawAgentWriteTransaction((current) => {
      for (let index = 0; index < sessions; index++) {
        entries.writeSessionEntry(current, key(index), initial(index));
      }
    }, options);
    if (values.mode === "metadata") {
      await measureMetadata(database, options, key, initial);
      return;
    }
    const keys = Array.from({ length: batch }, (_, index) => key(index));
    let revision = 1000;
    const prepare = () => {
      const snapshot = reads.readSessionEntryReplacementState(database, { sessionKeys: keys });
      revision++;
      return {
        expectedRows: snapshot.expectedRows,
        labelOwnerKeys: [],
        validationKeys: keys,
        replacements: snapshot.entries.map(({ sessionKey, entry }) => ({
          sessionKey,
          previousSessionKeys: [],
          entry: { ...entry, updatedAt: revision },
        })),
      };
    };
    const requests: Array<{
      requestClass: string;
      phase: string;
      queueWaitMs?: number;
      durationMs?: number;
      executeMs?: number;
    }> = [];
    let measuring = false;
    const stopMetrics = diagnostics.onWorkerRequestMetrics(
      (kind, requestClass, phase, _depth, queueWaitMs, durationMs, timing) => {
        if (
          measuring &&
          kind === "sqlite_writer" &&
          (phase === "started" || phase === "completed")
        ) {
          requests.push({
            requestClass,
            phase,
            queueWaitMs,
            durationMs,
            executeMs:
              timing?.executeStarted !== undefined && timing.executeFinished !== undefined
                ? timing.executeFinished - timing.executeStarted
                : undefined,
          });
        }
      },
    );
    const commit = async (input: ReturnType<typeof prepare>) => {
      if (values.mode === "worker") {
        await worker.withSessionEntryWorker(
          options,
          undefined,
          () => {},
          async (execution, source) => {
            await execution.prepare(source);
            await execution.runExisting(source, async (scope) => {
              await Promise.all([
                scope.execute({ type: "session.entries.replace", input }),
                ...Array.from({ length: 3 }, () =>
                  scope.execute({ type: "database.prepareWrite", input: undefined }),
                ),
              ]);
            });
          },
        );
        return;
      }
      const result = agent.runOpenClawAgentWriteTransaction(
        (current) => owner.commitSessionEntryReplacementsInDatabase(current, input, () => {}),
        options,
      );
      assert.equal(result.current.size, batch);
    };
    await commit(prepare());
    const hostLoadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const timing = [];
    measuring = true;
    for (let pass = 0; pass < passes; pass++) {
      const input = prepare();
      const profiler = new GCProfiler();
      profiler.start();
      const cpuStart = process.threadCpuUsage();
      const at = performance.now();
      await commit(input);
      const wallMs = performance.now() - at;
      const cpu = process.threadCpuUsage(cpuStart);
      const collections = profiler.stop()?.statistics ?? [];
      timing.push({
        wallMs,
        cpuMs: values.mode === "owner" ? (cpu.user + cpu.system) / 1000 : null,
        gcMs:
          values.mode === "owner"
            ? collections.reduce((sum, item) => sum + item.cost / 1000, 0)
            : null,
        gcCount: values.mode === "owner" ? collections.length : null,
        maxGcMs:
          values.mode === "owner"
            ? Math.max(0, ...collections.map((item) => item.cost / 1000))
            : null,
      });
    }
    measuring = false;
    stopMetrics();
    let allocatedBytes = 0;
    for (let pass = 0; values.mode === "owner" && pass < passes; pass++) {
      const input = prepare();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await commit(input);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      // Current V8 returns collected samples; the Node declaration omits them.
      const samples = (profile as unknown as SamplingProfile).samples;
      allocatedBytes += samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    if (values.profile && values.mode === "owner") {
      const input = prepare();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
      await commit(input);
      const { profile } = await inspector.post("Profiler.stop");
      await writeFile(`${output}.cpuprofile`, JSON.stringify(profile));
    }
    await agent.closeOpenClawAgentDatabaseByPathAsync(database.path, "main");
    const reopened = agent.openOpenClawAgentDatabase(options);
    const digest = createHash("sha256");
    for (let index = 0; index < sessions; index++) {
      const entry = entries.readExactSessionEntryRow(reopened, key(index))?.entry;
      assert(entry);
      assert.deepEqual(entry, {
        ...initial(index),
        updatedAt: index < batch ? revision : 1000,
      });
      digest.update(JSON.stringify(entry));
    }
    const report = {
      scope:
        values.mode === "owner"
          ? "native replacement owner and durable COMMIT; no worker transport or Gateway"
          : "shared writer replacement plus three prepareWrite neighbors; execute includes host grants; no Gateway",
      node: process.version,
      ownerSha256,
      sessions,
      batch,
      snapshotRepeats,
      passes,
      changedRowsPerMeasurement: passes * batch,
      timing,
      sampledBytesPerRow: values.mode === "owner" ? allocatedBytes / (passes * batch) : null,
      sampledBytesPerTransaction: values.mode === "owner" ? allocatedBytes / passes : null,
      requests,
      committedRowsSha256: digest.digest("hex"),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  });
} finally {
  inspector.disconnect();
}

async function measureMetadata(
  database: ReturnType<typeof agent.openOpenClawAgentDatabase>,
  options: { agentId: string; path: string; env: NodeJS.ProcessEnv },
  key: (index: number) => string,
  initial: (index: number) => InternalSessionEntry,
) {
  const [{ applySessionEntryCanonicalReplacements }, { projectSessionsPatchEntry }, admission] =
    await Promise.all([
      import("../../src/config/sessions/session-accessor.sqlite-replacement-projection.ts"),
      import("../../src/gateway/sessions-patch.ts"),
      import("../../src/state/openclaw-agent-write-admission.ts"),
    ]);
  const holdMs = Number(values["hold-ms"]);
  assert(Number.isFinite(holdMs) && holdMs >= 0);
  const fieldPatch = {
    fields: ["markedUnreadAt", "lastReadAt", "agentStatus"] as const,
    guardFields: ["markedUnreadAt", "archivedAt", "pluginOwnerId"] as const,
    snapshotFields: ["sessionDiffBaseline"] as const,
  };
  const latencies: number[] = [];
  const snapshotMs: number[] = [];
  const commitMs: number[] = [];
  const snapshotSizes: number[] = [];
  let requestNumber = 0;
  let writerCount = 0;
  const changedKeys = new Map<string, number>();
  let clock = 10_000;
  const patch = async (record: boolean) => {
    const sessionKeys = Array.from({ length: targetsPerPatch }, () =>
      key(requestNumber++ % Math.min(sessions - 1, 128)),
    );
    const acknowledgedAt = clock;
    for (const sessionKey of sessionKeys) {
      changedKeys.set(sessionKey, acknowledgedAt);
    }
    const started = performance.now();
    let snapshotAt = started;
    let commitAt = started;
    let committed: ReadonlyMap<string, InternalSessionEntry> | undefined;
    const result = await applySessionEntryCanonicalReplacements({
      ...options,
      storePath: database.path,
      sessionKeys,
      skipMaintenance: true,
      fieldPatch,
      onCommittedEntries: (current) => {
        committed = current;
      },
      update: async (rows) => {
        snapshotAt = performance.now();
        if (!record) {
          snapshotSizes.push(rows.reduce((sum, row) => sum + JSON.stringify(row.entry).length, 0));
        }
        const replacements = await Promise.all(
          rows.map(async (row) => {
            const projected = await projectSessionsPatchEntry({
              cfg: {},
              agentId: "main",
              storeKey: row.sessionKey,
              existingEntry: row.entry,
              patch: { key: row.sessionKey, unread: false },
              isLabelInUse: () => false,
            });
            assert(projected.ok);
            return { sessionKey: row.sessionKey, previousSessionKeys: [], entry: projected.entry };
          }),
        );
        commitAt = performance.now();
        return { result: replacements, replacements };
      },
    });
    for (const replacement of result) {
      const entry = committed?.get(replacement.sessionKey) ?? replacement.entry;
      assert.equal(entry.lastReadAt, acknowledgedAt);
      assert.equal(entry.archivedAt, 900);
    }
    if (record) {
      latencies.push(performance.now() - started);
      snapshotMs.push(snapshotAt - started);
      commitMs.push(performance.now() - commitAt);
    }
  };
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    for (let warm = 0; warm < 8; warm++) {
      clock++;
      await patch(false);
    }
    const loadBefore = loadavg();
    const memoryBefore = process.memoryUsage();
    const profiler = new GCProfiler();
    if (values.allocation) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } else {
      profiler.start();
    }
    const cpuStart = process.threadCpuUsage();
    const started = performance.now();
    for (let pass = 0; pass < passes; pass++) {
      clock++;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writer = admission.runOpenClawAgentWriteAdmission(options, async () => {
        entered();
        if (holdMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, holdMs);
          });
        }
        agent.runOpenClawAgentWriteTransaction((current) => {
          const sessionKey = key(sessions - 1);
          const row = entries.readExactSessionEntryRow(current, sessionKey);
          assert(row);
          entries.writeSessionEntry(current, sessionKey, {
            ...row.entry,
            inputTokens: ++writerCount,
          });
        }, options);
      });
      await held;
      await Promise.all([writer, ...Array.from({ length: batch }, () => patch(true))]);
    }
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuStart);
    const collections = values.allocation ? [] : (profiler.stop()?.statistics ?? []);
    const allocation = values.allocation
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    const percentile = (input: number[], fraction: number) =>
      input.toSorted((a, b) => a - b)[Math.floor(input.length * fraction)];
    const digest = createHash("sha256");
    for (const sessionKey of [...changedKeys.keys()].toSorted()) {
      const index = Number(sessionKey.split("-").at(-1));
      const entry = entries.readExactSessionEntryRow(database, sessionKey)?.entry;
      assert(entry);
      assert.deepEqual(entry, { ...initial(index), lastReadAt: changedKeys.get(sessionKey) });
      digest.update(JSON.stringify(entry));
    }
    const report = {
      scope:
        "real replacement owner with concurrent unrelated writer; no Gateway transport or model traffic",
      mode: values.allocation ? "allocation" : "timing",
      ownerSha256,
      ownerSources: Object.fromEntries(
        await Promise.all(
          ["projection", "read", "types", "state", "worker"].map(async (part) => {
            const name = `src/config/sessions/session-accessor.sqlite-replacement-${part}.ts`;
            const file = values["owner-dir"]
              ? path.join(path.resolve(values["owner-dir"]), name)
              : new URL(`../../${name}`, import.meta.url);
            return [
              name,
              createHash("sha256")
                .update(await readFile(file))
                .digest("hex"),
            ];
          }),
        ),
      ),
      sessions,
      batch,
      passes,
      holdMs,
      operations: latencies.length,
      targetsPerPatch,
      writerCount,
      wallMs,
      snapshotP50Ms: percentile(snapshotMs, 0.5),
      snapshotP95Ms: percentile(snapshotMs, 0.95),
      commitP50Ms: percentile(commitMs, 0.5),
      commitP95Ms: percentile(commitMs, 0.95),
      patchP50Ms: percentile(latencies, 0.5),
      patchP95Ms: percentile(latencies, 0.95),
      mainThreadCpuUsPerPatch: (cpu.user + cpu.system) / latencies.length,
      sampledBytesPerPatch: allocation ? allocated(allocation.head) / latencies.length : null,
      gcMs: collections.reduce((sum, item) => sum + item.cost / 1000, 0),
      gcCount: collections.length,
      gcByKind: Object.fromEntries(
        [...new Set(collections.map((item) => item.gcType))].map((kind) => {
          const selected = collections.filter((item) => item.gcType === kind);
          return [
            kind,
            {
              count: selected.length,
              ms: selected.reduce((sum, item) => sum + item.cost / 1000, 0),
              maxMs: Math.max(0, ...selected.map((item) => item.cost / 1000)),
            },
          ];
        }),
      ),
      maxGcMs: Math.max(0, ...collections.map((item) => item.cost / 1000)),
      preparedEntryBytes: snapshotSizes[0],
      committedRowsSha256: digest.digest("hex"),
      loadBefore,
      loadAfter: loadavg(),
      memoryBefore,
      memoryAfter: process.memoryUsage(),
    };
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    Date.now = realNow;
  }
}
