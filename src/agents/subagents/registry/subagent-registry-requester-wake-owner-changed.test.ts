import { describe, expect, it, vi } from "vitest";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { settleOrReportRequesterWake } from "./subagent-registry-requester-wake-owner-changed.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// The owner-changed report policy alone (openclaw#154252): a different failing run restarts the
// count. The warning budget and storage errors are covered through the real controller and
// SQLite store in subagent-registry.requester-wake-owner-changed.test.ts, and yield cohorts in
// ../completion/subagent-completion-admission.owner-changed.test.ts.
const OWNER_CHANGED = "subagent completion owner changed before settlement";
const ownerChanged = (runId: string) => new Error(`${OWNER_CHANGED}: ${runId}`);

function createPolicy() {
  const warn = vi.fn();
  const context = { options: { warn } } as unknown as SubagentLifecycleWakeContext;
  const episode = { failures: 0 } as PendingRequesterSettleWakeCommit;
  const members = [{ runId: "run-a" }] as SubagentRunRecord[];
  const attempt = (error: unknown) =>
    settleOrReportRequesterWake(context, episode, members, async () => {
      throw error;
    }).catch((caught: unknown) => caught);
  return { warn, episode, attempt };
}

describe("settleOrReportRequesterWake", () => {
  it("a different signature restarts the count", async () => {
    const { warn, episode, attempt } = createPolicy();
    for (let i = 0; i < 5; i += 1) {
      await attempt(ownerChanged("run-a"));
    }
    expect(episode.ownerChangedReported).toBe(true);
    await attempt(ownerChanged("run-b"));
    expect(episode).toMatchObject({ ownerChangedReported: false, ownerChangedFailures: 1 });
    for (let i = 0; i < 3; i += 1) {
      await attempt(ownerChanged("run-b"));
    }
    expect(episode.ownerChangedReported).toBe(false);
    await attempt(ownerChanged("run-b"));
    expect(episode.ownerChangedReported).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
