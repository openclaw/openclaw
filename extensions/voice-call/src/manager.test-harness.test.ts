import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
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
  const allocated = { duration: 0, transcript: 0 };
  const workerBaseline = fixtureWorkerCounts();
  const pending = new Map<
    Parameters<typeof clearTimeout>[0],
    "duration" | "transcript" | "database-timer"
  >();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const scheduling = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      const timer = schedule(
        function (this: unknown, ...callbackArgs: unknown[]) {
          pending.delete(timer);
          Reflect.apply(callback, this, callbackArgs);
        },
        delay,
        ...args,
      );
      const owner = ownership.getStore();
      if (owner) {
        // Database idle timers inherit caller context but are not call timers.
        if (delay === timerMs[owner]) {
          allocated[owner]++;
          pending.set(timer, owner);
          if (owner === "transcript") {
            transcriptAllocated.resolve();
          }
        } else {
          pending.set(timer, "database-timer");
        }
      }
      return timer;
    });
  const cancelling = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    cancel(timer);
    pending.delete(timer);
  });
  const fixtures: Array<Awaited<ReturnType<typeof createManagerHarness>>> = [];
  const calls: CallRecord[] = [];
  let turn: ReturnType<(typeof fixtures)[number]["manager"]["continueCall"]> | undefined;
  let turnResult: Awaited<typeof turn>;

  // LIFO: verification follows fixture teardown; recovery and observers retire last.
  onTestFinished(() => {
    scheduling.mockRestore();
    cancelling.mockRestore();
    ownership.disable();
  });
  onTestFinished(async () => {
    // Failure cleanup uses carrier hangup, not the fixture's synthetic event.
    for (const { manager } of fixtures) {
      for (const call of manager.getActiveCalls()) {
        await manager.endCall(call.callId);
      }
    }
    await turn;
    await closeOpenClawStateDatabaseAsync();
    for (const { storePath } of fixtures) {
      fs.rmSync(storePath, { recursive: true, force: true });
    }
  });
  onTestFinished(async () => {
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
      turn = ownership.run("transcript", () =>
        fixture.manager.continueCall(started.callId, "Waiting for a reply").then((result) => {
          turnResult = result;
          return result;
        }),
      );
    }
  }
  // Durable call updates can span loop turns; wait for the actual transcript timer.
  await withinTest(
    awaitGateBeforeSettlement(
      transcriptAllocated.promise,
      expectDefined(turn, "fixture turn"),
      "fixture turn settled before allocating its transcript timer",
    ),
    signal,
  );
  expect(allocated).toEqual({ duration: 2, transcript: 1 });
  // Database admission workers can finish before fixture teardown; call timers must stay live.
  expect([...pending.values()].filter((owner) => owner !== "database-timer").toSorted()).toEqual([
    "duration",
    "duration",
    "transcript",
  ]);
  expect(turnResult).toBeUndefined();
});
