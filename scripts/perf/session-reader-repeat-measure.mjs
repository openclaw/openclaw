// Public-reader scenarios for session-reader-volume-measure.mjs; synthetic fixtures only.
// Serial calls own exact counter deltas. Concurrent callers share one wave delta;
// assigning overlapping deltas to individuals would count the same read repeatedly.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { evictLinuxFilePageCache } from "../lib/linux-page-cache.ts";

export async function measureRepeatedSessionReaders({
  values,
  root,
  fixture,
  samples,
  selected,
  target,
}) {
  assert(["absent", "retained"].includes(values.actor));
  const concurrency = Number(values.concurrency);
  assert(Number.isSafeInteger(concurrency) && concurrency >= 2 && concurrency <= 16);
  assert(fixture.sessions > 1);
  const other = selected === 0 ? 1 : 0;
  const { sampleTrackedWorkerMemory } = await import("../../src/infra/worker-cpu.js");
  const { prepareSessionTranscriptHydration } =
    await import("../../src/config/sessions/session-transcript-hydration.js");
  const { readSessionTranscriptAccountingAsync } =
    await import("../../src/gateway/session-transcript-readers.js");
  const { setRuntimeConfigSnapshot } = await import("../../src/config/config.js");
  const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  setRuntimeConfigSnapshot({});
  const digest = (value) =>
    createHash("sha256")
      .update(JSON.stringify(value, (_, item) => (item instanceof Map ? [...item] : item)))
      .digest("hex");
  const limits = { maxEvents: 50, maxBytes: 1024 * 1024 };
  const narrow = { maxEvents: 12, maxBytes: 512 * 1024 };
  const bytes = { includeByteSize: true, includeUsage: false };
  const all = { includeByteSize: true, includeUsage: true, includeTurnTaint: true };
  const hydrate = async (index, selection, cohort = false) => {
    const reader = prepareSessionTranscriptHydration(target(index), selection);
    let result;
    if (cohort) {
      assert(reader.readCohort);
      await reader.readCohort(
        {
          sessionKey: target(index).sessionKey,
          entryIds: [`event-${fixture.shapes[index].maxSeq - 1}`],
        },
        (prepared) => {
          result = prepared;
        },
      );
    } else {
      result = await reader.read();
    }
    assert.equal(result?.kind, "bounded");
    assert(result.snapshot.events.length > 0);
    assert.equal(result.snapshot.totalEvents, fixture.shapes[index].events - 1);
    assert(result.snapshot.events.length <= selection.maxEvents + 1);
    assert(result.snapshot.serializedBytes <= selection.maxBytes);
    return result;
  };
  const account = async (index, options) => {
    const result = await readSessionTranscriptAccountingAsync(target(index), options);
    assert(result.byteSize > 0 && result.eventCount > 0);
    if (options.includeUsage) {
      assert(result.usage?.promptTokens > 0);
    }
    return result;
  };
  const callers =
    values.operation === "hydration"
      ? [
          { name: "bounded", read: () => hydrate(selected, limits) },
          { name: "narrow", read: () => hydrate(selected, narrow) },
          { name: "other-session", read: () => hydrate(other, limits) },
          { name: "cohort", read: () => hydrate(selected, limits, true) },
        ]
      : [
          { name: "bytes", read: () => account(selected, bytes) },
          { name: "all", read: () => account(selected, all) },
          { name: "other-session", read: () => account(other, all) },
        ];
  const expected = new Map();
  const diagnostics = () => sampleTrackedWorkerMemory({ refresh: false });
  const difference = (before, after) =>
    after
      .map((entry) => {
        const previous = before.find((item) => item.operation === entry.operation);
        return {
          operation: entry.operation,
          count: entry.count - (previous?.count ?? 0),
          readBytes: entry.readBytes - (previous?.readBytes ?? 0),
        };
      })
      .filter((entry) => entry.count || entry.readBytes);
  const readCaller = async (caller, index) => {
    const started = performance.now();
    const result = await caller.read();
    const elapsedMs = performance.now() - started;
    return { caller: caller.name, index, elapsedMs, result };
  };
  const checkResult = ({ caller, result, ...timing }) => {
    const resultDigest = digest(result);
    const previous = expected.get(caller);
    if (previous) {
      assert.equal(resultDigest, previous, `${caller} changed without a write`);
    } else {
      expected.set(caller, resultDigest);
    }
    return { caller, ...timing, digest: resultDigest };
  };
  const sourceFiles = [
    "src/config/sessions/session-transcript-hydration.ts",
    "src/config/sessions/session-accessor.sqlite-reset-window.ts",
    "src/config/sessions/session-history-worker-runtime.ts",
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((filename) => [
      filename,
      createHash("sha256").update(readFileSync(filename)).digest("hex"),
    ]),
  );
  const admitted = [];
  const actors = [];
  const inspector = new Session();
  const measure = async (sample, phase, selectedCallers, concurrent) => {
    global.gc?.();
    if (values.allocation) {
      await startCollectedHeapSampling(inspector, 4096);
    }
    const before = diagnostics();
    const cpuBefore = process.cpuUsage();
    const mainBefore = process.threadCpuUsage();
    const started = performance.now();
    const results = concurrent
      ? await Promise.all(selectedCallers.map(readCaller))
      : [await readCaller(selectedCallers[0], 0)];
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const main = process.threadCpuUsage(mainBefore);
    const after = diagnostics();
    const readerMetrics = difference(before.sqliteReaderMetrics, after.sqliteReaderMetrics);
    let mainAllocatedBytes;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      mainAllocatedBytes = sumSampledHeapBytes(profile.head);
      inspector.disconnect();
    }
    console.log(
      JSON.stringify({
        operation: values.operation,
        flow: "repeat",
        actor: values.actor,
        label: values.label,
        sample,
        phase,
        concurrent,
        coldSeries: values.cold,
        elapsedMs,
        cpuMs: (cpu.user + cpu.system) / 1000,
        mainCpuMs: (main.user + main.system) / 1000,
        mainAllocatedBytes,
        readerMetrics,
        workerLifecycleBefore: before.workerLifecycle,
        workerLifecycleAfter: after.workerLifecycle,
        callers: results.map(checkResult),
        sourceHashes,
        databaseBytes: statSync(fixture.databasePath).size,
        sessions: fixture.sessions,
        selectedEvents: fixture.shapes[selected].events,
        loadavg: loadavg(),
        platform: process.platform,
        node: process.version,
      }),
    );
  };
  try {
    // Initialize public dispatch on a small unrelated session, leaving the measured
    // large sessions cold. This also starts counter registration before snapshotting.
    const warmups = Array.from({ length: fixture.sessions }, (_, index) => index)
      .filter((index) => index !== selected && index !== other)
      .slice(-concurrency);
    assert.equal(warmups.length, concurrency, "Need unrelated sessions for worker warmup");
    const warmup = warmups[0];
    if (values.operation === "hydration") {
      await hydrate(warmup, limits);
      await hydrate(warmup, limits, true);
    } else {
      await account(warmup, all);
    }
    await Promise.all(
      warmups.map((index) =>
        values.operation === "hydration" ? hydrate(index, limits) : account(index, all),
      ),
    );
    if (values.actor === "retained") {
      const { loadSessionEntryForAdmission } =
        await import("../../src/config/sessions/session-accessor.sqlite-entry-admission.js");
      const { createSessionActorFactory } =
        await import("../../src/config/sessions/session-actor-durable.js");
      const { readDatabasePathIdentitySync } =
        await import("../../src/infra/sqlite-worker-identity.js");
      for (const index of [selected, other]) {
        const { databaseClaim } = await loadSessionEntryForAdmission(target(index));
        admitted.push(databaseClaim);
        assert(databaseClaim.kind === "worker" && databaseClaim.reader);
        const reader = databaseClaim.reader;
        const assertCurrent = () => reader.assertCurrent();
        const identity = readDatabasePathIdentitySync(reader.database.path);
        assert(identity.key.startsWith("file:"));
        const actor = await createSessionActorFactory(reader.database).acquire(
          {
            sessionKey: target(index).sessionKey,
            database: {
              kind: "file",
              physicalIdentity: identity.key.slice(5),
              birthtime: identity.birthtime,
              nativeLocation: reader.database.path,
            },
          },
          { assertCurrent, assertReadable: assertCurrent },
        );
        actors.push(actor);
        await actor.read({ assertCurrent, authorize: assertCurrent });
      }
    }
    if (!values.cold) {
      for (const caller of callers) {
        checkResult(await readCaller(caller, 0));
      }
      // Actor-scoped concurrent dispatch can grow a different worker lane than
      // unrelated-session warmup. Exercise the exact measured waves before timing.
      for (const wave of [
        Array.from({ length: concurrency }, () => callers[0]),
        Array.from({ length: concurrency }, (_, index) => callers[index % callers.length]),
      ]) {
        (await Promise.all(wave.map(readCaller))).forEach(checkResult);
      }
    }
    for (let sample = 0; sample < samples; sample++) {
      if (values.cold) {
        for (const filename of [fixture.databasePath, fixture.databasePath + "-wal"]) {
          if (!existsSync(filename)) {
            continue;
          }
          assert(path.resolve(filename).startsWith(root + path.sep));
          evictLinuxFilePageCache(filename);
        }
      }
      for (const [index, caller] of [
        callers[0],
        callers[0],
        ...callers.slice(1),
        callers[0],
      ].entries()) {
        await measure(sample, `serial-${index}`, [caller], false);
      }
      await measure(
        sample,
        "identical-wave",
        Array.from({ length: concurrency }, () => callers[0]),
        true,
      );
      await measure(
        sample,
        "mixed-wave",
        Array.from({ length: concurrency }, (_, index) => callers[index % callers.length]),
        true,
      );
    }
    // Optional existing all-worker heap preload needs one final collection interval.
    if (values.allocation) {
      await delay(1200);
    }
  } finally {
    inspector.disconnect();
    for (const actor of actors.toReversed()) {
      await actor.release();
    }
    for (const claim of admitted.toReversed()) {
      await claim.release();
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    await drainGlobalSingletonLifecycleState();
  }
}
