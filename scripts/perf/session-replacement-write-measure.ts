/**
 * Measure the real session replacement transaction on synthetic, isolated state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-replacement-write-measure.ts
 *   --output .local/buf464/base.json --owner-dir .local/buf464/base
 * Omit --owner-dir for the candidate. The sparse overlay uses the existing worker
 * benchmark loader; preserve the baseline replacement-state.ts at its source path.
 * Defaults: 10,000 sessions, 1,000 changed rows per transaction, five transactions
 * per timing/allocation pass. Preparation and durable readback are outside timing.
 * This runs the native writer owner in this isolate, including COMMIT; it excludes
 * worker transport, Gateway activity and queue wait. Five transaction samples do
 * not qualify a latency percentile. Allocation sampling is a separate pass.
 * --mode worker instead sends each replacement followed by three prepareWrite
 * neighbors through the real shared writer. It reports execute and queue timing;
 * CPU/allocation in that mode do not describe the worker and are omitted.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    profile: { type: "boolean", default: false },
    mode: { type: "string", default: "owner" },
  },
});
assert(values.output, "--output is required");
const sessions = Number(values.sessions);
const batch = Number(values.batch);
const passes = Number(values.passes);
assert([sessions, batch, passes].every((n) => Number.isSafeInteger(n) && n > 0));
assert(batch <= sessions);
assert(values.mode === "owner" || values.mode === "worker");
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
      skillsSnapshot: { prompt: "Synthetic saved skill context. ".repeat(128), skills: [] },
      pluginExtensions: { synthetic: { payload: "Synthetic plugin state. ".repeat(32) } },
    });
    agent.runOpenClawAgentWriteTransaction((current) => {
      for (let index = 0; index < sessions; index++) {
        entries.writeSessionEntry(current, key(index), initial(index));
      }
    }, options);
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
