import { afterEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { createRequesterDescendantReader } from "./subagent-announce.requester-settle-descendants.js";

afterEach(() => {
  vi.restoreAllMocks();
  subagentRuns.clear();
});

function fixture() {
  const entry: SubagentRunRecord = {
    runId: "settled",
    childSessionKey: "agent:main:subagent:settled",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "synthetic task",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "terminal", startedAt: 2, endedAt: 3 },
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
  };
  subagentRuns.set(entry.runId, entry);
  const params = {
    requesterSessionKey: entry.requesterSessionKey,
    requesterAgentId: entry.requesterAgentId,
    requesterStorePath: null,
    settledEntry: entry,
    settledBefore: 4,
    isSourceCurrent: () => true,
  };
  return { entry, params, read: createRequesterDescendantReader(params) };
}

it("reads descendant facts without traversing unrelated retained runs", async () => {
  const { entry, read } = fixture();
  subagentRuns.set("unrelated", {
    ...entry,
    runId: "unrelated",
    childSessionKey: "agent:main:subagent:unrelated",
    requesterSessionKey: "agent:main:unrelated",
  });
  const values = vi.spyOn(subagentRuns, "values");
  await expect(read()).resolves.toEqual({ unsettled: false, active: 0 });
  expect(values).not.toHaveBeenCalled();
});

it.each(["removed", "replaced", "rearmed"] as const)(
  "discards descendant facts when the owner is %s during preparation",
  async (change) => {
    const { entry, read } = fixture();
    queueMicrotask(() => {
      if (change === "removed") {
        subagentRuns.delete(entry.runId);
      } else if (change === "replaced") {
        subagentRuns.set(entry.runId, { ...entry, generation: 2 });
      } else {
        subagentRuns.set(
          entry.runId,
          copySubagentRunRuntimeOwner(entry, {
            ...entry,
            requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 2 },
          }),
        );
      }
    });
    await expect(read()).resolves.toBeUndefined();
  },
);

it.each([
  { requesterSessionKey: "agent:main:other" },
  { requesterAgentId: "other" },
  { requesterStorePath: "other-store" },
])("keeps requester scope restrictions: %j", async (scope) => {
  const { params } = fixture();
  await expect(createRequesterDescendantReader({ ...params, ...scope })()).resolves.toBeUndefined();
});

it("follows an accepted collector address without adopting a different owner", async () => {
  const { entry, params } = fixture();
  const queued = { ...entry, collect: true, swarmRunId: entry.runId };
  subagentRuns.set(queued.runId, queued);
  const read = createRequesterDescendantReader({ ...params, settledEntry: queued });
  queueMicrotask(() => {
    subagentRuns.delete(queued.runId);
    subagentRuns.set(
      "accepted",
      copySubagentRunRuntimeOwner(queued, { ...queued, runId: "accepted" }),
    );
  });
  await expect(read()).resolves.toEqual({ unsettled: false, active: 0 });
});
