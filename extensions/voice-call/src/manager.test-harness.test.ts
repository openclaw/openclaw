import { AsyncLocalStorage, createHook } from "node:async_hooks";
import fs from "node:fs";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  closeOpenClawStateDatabaseAsync,
  getTrackedWorkerLifecycleSnapshot,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { createManagerHarness, markCallAnswered } from "./manager.test-harness.js";
import type { CallRecord } from "./types.js";

const fixtureWorkerScripts = ["sqlite-store.worker.js", "gateway-state-owner-heartbeat.worker.js"];

function fixtureWorkerCounts() {
  return new Map(
    getTrackedWorkerLifecycleSnapshot().workerLifecycle.map(({ script, started, retired }) => [
      script,
      { started, retired: retired.reduce((total, entry) => total + entry.count, 0) },
    ]),
  );
}

it("finalizes fixture calls and releases their timers, database workers, and directories", async ({
  signal,
}) => {
  const ownership = new AsyncLocalStorage<"duration" | "transcript">();
  const transcriptAllocated = createDeferred<void>();
  const timerMs = { duration: 317_000, transcript: 43_100 };
  const timerDelay = new AsyncLocalStorage<number | undefined>();
  const schedule = globalThis.setTimeout;
  const scheduling = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) =>
      timerDelay.run(delay, () => schedule(callback, delay, ...args)),
    );
  const allocated = { duration: 0, transcript: 0 };
  const workerBaseline = fixtureWorkerCounts();
  const pending = new Map<number, "duration" | "transcript" | "database-timer">();
  const observer = createHook({
    init(id, type) {
      const owner = ownership.getStore();
      if (type === "Timeout" && owner) {
        // Database operations inherit caller context too. Keep their idle
        // timers under observation without miscounting them as call timers.
        if (timerDelay.getStore() === timerMs[owner]) {
          allocated[owner]++;
          pending.set(id, owner);
          if (owner === "transcript") {
            transcriptAllocated.resolve();
          }
        } else {
          pending.set(id, "database-timer");
        }
      }
    },
    destroy(id) {
      pending.delete(id);
    },
  }).enable();
  const fixtures: Array<Awaited<ReturnType<typeof createManagerHarness>>> = [];
  const calls: CallRecord[] = [];
  const turns: Array<ReturnType<(typeof fixtures)[number]["manager"]["continueCall"]>> = [];
  let turnResult: Awaited<(typeof turns)[number]> | undefined;

  // Finish hooks are LIFO: register verification before allocating fixtures so
  // it observes their cleanup, after afterEach and fixture teardown have run.
  onTestFinished(async () => {
    try {
      await setImmediate(); // Node delivers timer destroy events on the next loop.
      expect(allocated).toEqual({ duration: 2, transcript: 1 });
      const workers = fixtureWorkerCounts();
      for (const script of fixtureWorkerScripts) {
        const before = workerBaseline.get(script) ?? { started: 0, retired: 0 };
        const after = expectDefined(workers.get(script), `fixture worker ${script}`);
        const started = after.started - before.started;
        expect(started, `fixture created ${script}`).toBeGreaterThan(0);
        expect(after.retired - before.retired, `fixture retired ${script}`).toBe(started);
      }
      expect([...pending.values()], "fixture timers surviving test cleanup").toEqual([]);
      for (const [index, { manager, provider, storePath }] of fixtures.entries()) {
        expect(manager.getActiveCalls()).toEqual([]);
        expect(provider.hangupCalls).toEqual([]);
        expect(calls[index]).toMatchObject({
          state: "hangup-user",
          endReason: "hangup-user",
          endedAt: expect.any(Number),
        });
        expect(fs.existsSync(storePath)).toBe(false);
      }
      expect(turnResult).toEqual({ success: false, error: "Call ended: hangup-user" });
    } finally {
      try {
        // Keep failing-before proof contained; this runs only after assertions
        // and uses carrier hangup, not the fixture's synthetic terminal event.
        for (const { manager } of fixtures) {
          for (const call of manager.getActiveCalls()) {
            await manager.endCall(call.callId);
          }
        }
        await Promise.all(turns);
        await closeOpenClawStateDatabaseAsync();
        for (const { storePath } of fixtures) {
          fs.rmSync(storePath, { recursive: true, force: true });
        }
      } finally {
        observer.disable();
        scheduling.mockRestore();
        timerDelay.disable();
        ownership.disable();
      }
    }
  });

  for (let index = 0; index < 2; index++) {
    const fixture = await createManagerHarness({
      maxDurationSeconds: timerMs.duration / 1000,
      transcriptTimeoutMs: timerMs.transcript,
    });
    fixtures.push(fixture);
    const started = await fixture.manager.initiateCall("+15550000001");
    expect(started.success).toBe(true);
    calls.push(expectDefined(fixture.manager.getCall(started.callId), "fixture call"));
    await ownership.run("duration", () =>
      markCallAnswered(fixture.manager, started.callId, `answered-${index}`),
    );
    if (index === 0) {
      turns.push(
        ownership.run("transcript", () =>
          fixture.manager.continueCall(started.callId, "Waiting for a reply").then((result) => {
            turnResult = result;
            return result;
          }),
        ),
      );
    }
  }
  // Durable call updates can span loop turns; wait for the actual transcript timer.
  await withinTest(
    awaitGateBeforeSettlement(
      transcriptAllocated.promise,
      Promise.all(turns),
      "fixture turn settled before allocating its transcript timer",
    ),
    signal,
  );
  expect(allocated).toEqual({ duration: 2, transcript: 1 });
  // Database admission workers can finish before fixture teardown; call timers must stay live.
  expect(
    [...pending.values()]
      .filter((owner) => owner === "duration" || owner === "transcript")
      .toSorted(),
  ).toEqual(["duration", "duration", "transcript"]);
  expect(turnResult).toBeUndefined();
});
