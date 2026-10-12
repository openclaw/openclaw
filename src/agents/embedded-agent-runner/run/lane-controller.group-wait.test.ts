// Group-blocked lanes look idle locally but must suspend the cron setup watchdog.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { shouldNoteLaneWait } from "./lane-runtime.js";

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

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
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
    const gates = Array.from({ length: 7 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();

    const snapshot = getCommandLaneSnapshot(CRON);
    // This is the state that defeats a lane-local predicate: under its own
    // maxConcurrent, nothing queued, yet unable to start.
    expect(snapshot.activeCount).toBe(7);
    expect(snapshot.maxConcurrent).toBe(8);
    expect(snapshot.queuedCount).toBe(0);
    expect(snapshot.queuedCount > 0 || snapshot.activeCount >= snapshot.maxConcurrent).toBe(false);

    // ...and the predicate must still report the wait, or the watchdog never
    // suppresses its setup timeout and the run fails spuriously.
    expect(shouldNoteLaneWait(snapshot)).toBe(true);

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("no wait is reported when the lane can start immediately", async () => {
    expect(shouldNoteLaneWait(getCommandLaneSnapshot(CRON))).toBe(false);
    expect(shouldNoteLaneWait(getCommandLaneSnapshot(HOOK))).toBe(false);

    const g = gate();
    const run = enqueueCommandInLane(CRON, async () => await g.promise);
    await settle();
    // One active out of eight: still admits, still no wait.
    expect(shouldNoteLaneWait(getCommandLaneSnapshot(CRON))).toBe(false);

    g.release();
    await run;
  });
});
