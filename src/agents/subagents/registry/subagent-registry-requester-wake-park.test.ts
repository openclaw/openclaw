import { describe, expect, it, vi } from "vitest";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS } from "./subagent-registry-requester-wake-commit.js";
import { settleOrParkRequesterWake } from "./subagent-registry-requester-wake-park.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// The park policy alone (openclaw#154252): which failures count, when the episode parks and when
// it un-parks. The controller and SQLite proof is in subagent-registry.requester-wake-park.test.ts.
const OWNER_CHANGED = "subagent completion owner changed before settlement";
const ownerChanged = (runId: string) => new Error(`${OWNER_CHANGED}: ${runId}`);

function createPolicy() {
  const warn = vi.fn();
  const context = { options: { warn } } as unknown as SubagentLifecycleWakeContext;
  const episode = { failures: 0 } as PendingRequesterSettleWakeCommit;
  const members = [{ runId: "run-a" }] as SubagentRunRecord[];
  const attempt = (error: unknown, batch = members) =>
    settleOrParkRequesterWake(context, episode, batch, async () => {
      throw error;
    }).catch((caught: unknown) => caught);
  return { warn, episode, members, attempt };
}

describe("settleOrParkRequesterWake", () => {
  it("parks on the fifth identical owner-changed rejection, warns once and rethrows every one", async () => {
    const { warn, episode, attempt } = createPolicy();
    for (let i = 1; i <= 7; i += 1) {
      const error = ownerChanged("run-a");
      expect(await attempt(error)).toBe(error);
      expect(episode.parked === true).toBe(i >= 5);
    }
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("requester settle wake parked", {
      signature: OWNER_CHANGED,
      failures: 5,
      probeIntervalMs: REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS,
      runIds: ["***"],
    });
  });

  it("a different signature restarts the count and un-parks", async () => {
    const { warn, episode, attempt } = createPolicy();
    for (let i = 0; i < 5; i += 1) {
      await attempt(ownerChanged("run-a"));
    }
    expect(episode.parked).toBe(true);
    await attempt(ownerChanged("run-b"));
    expect(episode).toMatchObject({ parked: false, ownerChangedFailures: 1 });
    for (let i = 0; i < 3; i += 1) {
      await attempt(ownerChanged("run-b"));
    }
    expect(episode.parked).toBe(false);
    await attempt(ownerChanged("run-b"));
    expect(episode.parked).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("a storage or transport error resets the count and un-parks", async () => {
    const { warn, episode, attempt } = createPolicy();
    for (let i = 0; i < 5; i += 1) {
      await attempt(ownerChanged("run-a"));
    }
    await attempt(new Error("database is locked"));
    expect(episode).toMatchObject({ parked: false, ownerChangedFailures: 0 });
    for (let i = 0; i < 4; i += 1) {
      await attempt(ownerChanged("run-a"));
    }
    expect(episode.parked).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never parks a yield cohort member", async () => {
    const { warn, episode, members, attempt } = createPolicy();
    const paused = [
      ...members,
      { runId: "run-b", pauseReason: "sessions_yield" },
    ] as SubagentRunRecord[];
    for (let i = 0; i < 10; i += 1) {
      await attempt(ownerChanged("run-a"), paused);
    }
    expect(episode.parked).toBeFalsy();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the settle result untouched and leaves a clean episode alone", async () => {
    const { warn, episode, members } = createPolicy();
    const context = { options: { warn } } as unknown as SubagentLifecycleWakeContext;
    await expect(
      settleOrParkRequesterWake(context, episode, members, async () => true),
    ).resolves.toBe(true);
    expect(episode.parked).toBeUndefined();
  });
});
