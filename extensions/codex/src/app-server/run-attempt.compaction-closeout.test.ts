import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

type TestParams = ReturnType<typeof createTestParams>;

function makeTestParams(overrides: Partial<TestParams> = {}): TestParams {
  return { ...createTestParams(), ...overrides };
}

describe("runCodexAppServerAttempt compaction closeout", () => {
  it("closes visible compaction after client loss without making observed work replayable", async () => {
    const started = createDeferred<void>();
    const onAgentEvent = vi.fn<NonNullable<TestParams["onAgentEvent"]>>((event) => {
      if (event.stream === "compaction" && event.data.phase === "start") {
        started.resolve();
      }
    });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(makeTestParams({ onAgentEvent }));
    try {
      await run.waitForTurnAccepted();
      await harness.notify(
        itemNotification("item/started", { type: "contextCompaction", id: "compact-client-loss" }),
      );
      await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error("Attempt ended before compaction progress started");
        }),
      ]);
      harness.close();
      const result = await run;

      expect(result.codexAppServerFailure).toMatchObject({
        kind: "client_closed_before_turn_completed",
        replaySafe: false,
        replayBlockedReason: "active_item",
      });
      expect(result.itemLifecycle).toEqual({ startedCount: 1, completedCount: 0, activeCount: 0 });
      expect(result.compactionCount).toBeUndefined();
      expect(
        onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "compaction"),
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ phase: "start", itemId: "compact-client-loss" }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "end",
            itemId: "compact-client-loss",
            completed: false,
          }),
        }),
      ]);
    } finally {
      harness.close();
      await run.catch(() => {});
    }
  });
});
