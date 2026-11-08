// Group-blocked lanes look idle locally but must suspend the cron setup watchdog.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const GROUP = "cron-hooks";

type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];

function setCommandLaneGroup(group: string, spec: LaneGroupSpec): void {
  publishLaneConfiguration({ groups: { [group]: spec } });
}

function clearCommandLaneGroup(group: string): void {
  publishLaneConfiguration({ clearGroups: [group] });
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  setCommandLaneConcurrency(CRON, 8);
  setCommandLaneConcurrency(HOOK, 8);
  setCommandLaneGroup(GROUP, {
    budget: 8,
    members: [CRON, HOOK],
    reservations: { [HOOK]: 1 },
  });
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
  resetAllLanes();
});

describe("group-blocked lane waits are reported", () => {
  test("8th cron run blocked by the hook's reserve reports a wait", async () => {
    // 7 cron active; the 8th slot is the hook's hard reservation.
    const gates = Array.from({ length: 7 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));

    const snapshot = getCommandLaneSnapshot(CRON);
    // This is the state that defeats a lane-local predicate: under its own
    // maxConcurrent, nothing queued, yet unable to start.
    expect(snapshot.activeCount).toBe(7);
    expect(snapshot.maxConcurrent).toBe(8);
    expect(snapshot.queuedCount).toBe(0);
    expect(snapshot.queuedCount > 0 || snapshot.activeCount >= snapshot.maxConcurrent).toBe(false);

    const onQueued = vi.fn();
    const queued = enqueueCommandInLane(CRON, async () => {}, { onQueued });
    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedAhead: 0,
        details: expect.stringContaining("blockedBy=sibling-reservation"),
      }),
    );

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all([...runs, queued]);
  });

  test("no wait is reported when the lane can start immediately", async () => {
    const onQueued = vi.fn();

    const g = createDeferred();
    const run = enqueueCommandInLane(CRON, async () => await g.promise, { onQueued });
    expect(onQueued).not.toHaveBeenCalled();

    g.resolve();
    await run;
  });
});
