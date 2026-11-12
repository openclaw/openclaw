/**
 * Owner-boundary proof over usage-refresh-stats-measure.ts's synthetic agent DB.
 * First enrich only that fixture: --root <fixture> --prepare-identity.
 * Then: --root <fixture> --operation identity|hydration|accounting --revision <base>
 *   --samples 5 [--cold] [--allocation] [--profile-dir <directory>]
 * Each A1/A2/B sample uses a fresh worker and admitted connection. The exact production
 * SQL owners run inside withHistoryDatabase and its cumulative physical-read counters.
 * A1/A2 load the selected owners from --revision; B uses the working tree. Gitless
 * copies accept --baseline-file <json> --baseline-sha256 <hash>: an exact object
 * mapping the selected repository-relative owner paths below to their source text.
 * Admission/module warmup is excluded; SQLite pages are released before every sample.
 * Cold additionally evicts only the owned DB/WAL with Linux fadvise. Warm retains the
 * OS cache after warming the complete selected operation. Allocation samples this
 * worker, excluding native SQLite allocations. Acceptance: identical complete
 * results, less work and no material regression; physical reads may remain unchanged
 * when both queries use the same pages. Report CPU/time against A/A spread and any
 * >20% regression. These are owner measurements, not Gateway/RPC latency.
 * --flow repeat --actor absent|retained --label A1 exercises the public async readers
 * in this source checkout. Run pinned baseline/candidate checkouts separately; the
 * kernel baseline hooks below do not propagate to the public readers' child workers.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { evictLinuxFilePageCache } from "../lib/linux-page-cache.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    operation: { type: "string", default: "identity" },
    flow: { type: "string", default: "kernel" },
    actor: { type: "string", default: "absent" },
    label: { type: "string", default: "candidate" },
    concurrency: { type: "string", default: "4" },
    revision: { type: "string" },
    "baseline-file": { type: "string" },
    "baseline-sha256": { type: "string" },
    samples: { type: "string", default: "5" },
    session: { type: "string", default: "0" },
    "prepare-identity": { type: "boolean", default: false },
    "identity-padding-bytes": { type: "string", default: "2688" },
    cold: { type: "boolean", default: false },
    allocation: { type: "boolean", default: false },
    "profile-dir": { type: "string" },
  },
});
assert(values.root, "--root must name a synthetic fixture");
assert(["identity", "hydration", "accounting"].includes(values.operation));
assert(!values.cold || process.platform === "linux", "--cold requires Linux");
const root = path.resolve(values.root);
const fixture = JSON.parse(
  readFileSync(path.join(root, "usage-refresh-stats-fixture.json"), "utf8"),
);
assert.equal(fixture.format, "openclaw-usage-refresh-stats-v1");
assert(path.resolve(fixture.databasePath).startsWith(root + path.sep));
const samples = Number(values.samples);
const selected = Number(values.session);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(selected) && selected >= 0 && selected < fixture.sessions);
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
const target = (index) => {
  const sessionId = `synthetic-usage-${String(index).padStart(5, "0")}`;
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    path: fixture.databasePath,
    storePath: fixture.databasePath,
  };
};
const ownerFiles = {
  identity: [
    "src/config/sessions/session-accessor.sqlite-entry-availability.ts",
    "src/config/sessions/session-accessor.sqlite-entry-read.ts",
  ],
  hydration: ["src/config/sessions/session-accessor.sqlite-active-context.ts"],
  accounting: [
    "src/config/sessions/session-transcript-accounting.ts",
    "src/config/sessions/session-transcript-accounting-policy.ts",
  ],
}[values.operation];

if (values.flow === "repeat") {
  assert(isMainThread && !values.revision && !values["baseline-file"]);
  assert(["hydration", "accounting"].includes(values.operation));
  const { measureRepeatedSessionReaders } = await import("./session-reader-repeat-measure.mjs");
  await measureRepeatedSessionReaders({ values, root, fixture, samples, selected, target });
} else if (isMainThread) {
  assert.equal(values.flow, "kernel");
  if (values["prepare-identity"]) {
    const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
      await import("../../src/state/openclaw-agent-db.js");
    const { writeSessionEntry } =
      await import("../../src/config/sessions/session-accessor.sqlite-entry-write.js");
    const paddingBytes = Number(values["identity-padding-bytes"]);
    assert(Number.isSafeInteger(paddingBytes) && paddingBytes >= 0);
    const labelUnit = "synthetic identity metadata ";
    const label = labelUnit
      .repeat(Math.ceil(paddingBytes / labelUnit.length))
      .slice(0, paddingBytes);
    for (let start = 0; start < fixture.sessions; start += 250) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = start; index < Math.min(start + 250, fixture.sessions); index++) {
            const scope = target(index);
            writeSessionEntry(database, scope.sessionKey, {
              sessionId: scope.sessionId,
              updatedAt: 1_793_528_460_000,
              label,
            });
          }
        },
        { agentId: "main", path: fixture.databasePath },
        { operationLabel: "synthetic identity fixture" },
      );
    }
    await closeOpenClawAgentDatabasesAsync();
    console.log(JSON.stringify({ prepared: fixture.sessions, labelBytes: label.length }));
  } else {
    assert(!(values.revision && values["baseline-file"]), "choose revision or baseline file");
    const baseline = values["baseline-file"]
      ? (() => {
          const source = readFileSync(values["baseline-file"], "utf8");
          assert.equal(
            createHash("sha256").update(source).digest("hex"),
            values["baseline-sha256"],
          );
          const sources = JSON.parse(source);
          assert.deepEqual(
            Object.keys(sources).toSorted((a, b) => a.localeCompare(b)),
            ownerFiles.toSorted((a, b) => a.localeCompare(b)),
          );
          return Object.fromEntries(
            ownerFiles.map((filename) => {
              assert.equal(typeof sources[filename], "string");
              return [pathToFileURL(path.resolve(filename)).href, sources[filename]];
            }),
          );
        })()
      : values.revision
        ? Object.fromEntries(
            ownerFiles.map((filename) => {
              const result = spawnSync("git", ["show", `${values.revision}:${filename}`], {
                encoding: "utf8",
                maxBuffer: 4 * 1024 * 1024,
              });
              assert.equal(result.status, 0, result.stderr);
              return [pathToFileURL(path.resolve(filename)).href, result.stdout];
            }),
          )
        : undefined;
    let expectedDigest;
    for (let sample = 0; sample < samples; sample++) {
      for (const label of sample % 2 ? ["B", "A2", "A1"] : ["A1", "A2", "B"]) {
        const worker = new Worker(new URL(import.meta.url), {
          argv: process.argv.slice(2),
          workerData: { baseline: label === "B" ? undefined : baseline, sample, label },
        });
        let record;
        worker.on("message", (message) => {
          record = message;
        });
        await new Promise((resolve, reject) => {
          worker.on("error", reject);
          worker.on("exit", (code) =>
            code ? reject(new Error(`worker exit ${code}`)) : resolve(),
          );
        });
        assert(record, "worker did not publish a measurement");
        expectedDigest ??= record.digest;
        assert.equal(record.digest, expectedDigest, "baseline/candidate results differ");
        console.log(JSON.stringify(record));
      }
    }
  }
} else {
  if (workerData.baseline) {
    registerHooks({
      load(url, context, nextLoad) {
        const source = workerData.baseline[url];
        return source === undefined
          ? nextLoad(url, context)
          : { source, format: "module-typescript", shortCircuit: true };
      },
    });
  }
  const { withHistoryDatabase } =
    await import("../../src/config/sessions/session-transcript-worker-scopes.js");
  const { withOpenClawAgentDatabaseReadOnly } =
    await import("../../src/state/openclaw-agent-db-readonly.js");
  const { readSessionIdentityEvidenceInDatabase } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-availability.js");
  const { readSessionTranscriptBoundedActiveContextCore } =
    await import("../../src/config/sessions/session-accessor.sqlite-active-context.js");
  const { readCurrentProjectionSnapshot } =
    await import("../../src/config/sessions/session-accessor.sqlite-projection-read.js");
  const { readSessionTranscriptAccountingFromProjection } =
    await import("../../src/config/sessions/session-transcript-accounting.js");
  const { runSqliteReadSnapshotSync } = await import("../../src/infra/sqlite-transaction.js");
  const { sqliteReaderCounter } = await import("../../src/infra/sqlite-reader-metrics.js");
  const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
  const { startCollectedHeapSampling, sumSampledHeapBytes } =
    await import("../lib/heap-sampling.ts");
  const location = { agentId: "main", path: fixture.databasePath };
  const operation = {
    identity: "session-identity-evidence",
    hydration: "transcript-hydration",
    accounting: "history.active-accounting",
  }[values.operation];
  const identities = Array.from({ length: fixture.sessions }, (_, index) => target(index));
  const read = (index, warmup = false) =>
    withHistoryDatabase(location, operation, () => {
      const result = withOpenClawAgentDatabaseReadOnly((database) => {
        if (values.operation === "identity") {
          return readSessionIdentityEvidenceInDatabase(
            database,
            warmup ? [target(index)] : identities,
          );
        }
        return runSqliteReadSnapshotSync(database.db, () =>
          values.operation === "hydration"
            ? readSessionTranscriptBoundedActiveContextCore(target(index), {
                maxEvents: 50,
                maxBytes: 1024 * 1024,
                transaction: database,
                resolvedScope: target(index),
              })
            : readCurrentProjectionSnapshot(database, target(index), (projection) =>
                readSessionTranscriptAccountingFromProjection(projection, {
                  includeByteSize: true,
                  includeUsage: true,
                  includeTurnTaint: true,
                }),
              ),
        );
      }, location);
      assert(result.found);
      return result.value;
    });
  await read(fixture.sessions - 1, true);
  if (!values.cold) {
    await read(selected);
  }
  await withHistoryDatabase(location, operation, () =>
    withOpenClawAgentDatabaseReadOnly(({ db }) => {
      db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048; PRAGMA shrink_memory");
    }, location),
  );
  if (values.cold) {
    for (const filename of [fixture.databasePath, fixture.databasePath + "-wal"]) {
      if (!existsSync(filename)) {
        continue;
      }
      evictLinuxFilePageCache(filename);
    }
  }
  const inspector = new Session();
  global.gc?.();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  if (values["profile-dir"]) {
    if (!values.allocation) {
      inspector.connect();
    }
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const counter = sqliteReaderCounter(`sessions.${operation}`).values;
  const before = [...counter];
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const result = await read(selected);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const readerMetrics = {
    operation: `sessions.${operation}`,
    count: Number(counter[0] - before[0]),
    readBytes: Number(counter[1] - before[1]),
  };
  if (process.platform === "linux") {
    assert.equal(readerMetrics.count, 1);
  }
  let sampledAllocatedBytes;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledAllocatedBytes = sumSampledHeapBytes(profile.head);
  }
  if (values["profile-dir"]) {
    const { profile } = await inspector.post("Profiler.stop");
    mkdirSync(values["profile-dir"], { recursive: true });
    writeFileSync(
      path.join(
        values["profile-dir"],
        `${values.operation}-${workerData.label}-${workerData.sample}.cpuprofile`,
      ),
      JSON.stringify(profile),
    );
  }
  inspector.disconnect();
  if (values.operation === "identity") {
    assert.deepEqual(
      result.value,
      identities.map(({ sessionKey }) => ({ status: "current", sessionKey })),
    );
  } else if (values.operation === "hydration") {
    assert(result.value.events.length > 0);
    assert.equal(result.value.totalEvents, fixture.shapes[selected].events - 1);
    assert(result.value.serializedBytes <= 1024 * 1024);
  } else {
    assert.equal(result.value.kind, "value", "accounting projection must be available");
    assert(result.value.value.byteSize > 0);
    assert(result.value.value.eventCount > 0);
  }
  const serialize = (_, value) => (value instanceof Map ? [...value] : value);
  parentPort.postMessage(
    {
      operation: values.operation,
      label: workerData.label,
      sample: workerData.sample,
      revision: workerData.baseline ? (values.revision ?? "baseline-file") : "working-tree",
      sourceHashes: Object.fromEntries(
        ownerFiles.map((filename) => [
          filename,
          createHash("sha256")
            .update(
              workerData.baseline?.[pathToFileURL(path.resolve(filename)).href] ??
                readFileSync(filename, "utf8"),
            )
            .digest("hex"),
        ]),
      ),
      cold: values.cold,
      databaseBytes: statSync(fixture.databasePath).size,
      sessions: fixture.sessions,
      selectedEvents: fixture.shapes[selected].events,
      elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      sampledAllocatedBytes,
      readerMetrics: process.platform === "linux" ? readerMetrics : undefined,
      digest: createHash("sha256").update(JSON.stringify(result.value, serialize)).digest("hex"),
      loadavg: loadavg(),
      availableParallelism: availableParallelism(),
      totalmem: totalmem(),
      platform: process.platform,
      node: process.version,
    },
    [],
  );
  await closeOpenClawAgentDatabasesAsync();
}
