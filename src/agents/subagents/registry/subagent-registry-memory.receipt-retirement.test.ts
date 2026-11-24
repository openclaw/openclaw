// Committed child-row removal must retire the requester's accepted completion receipt.
import { afterEach, describe, expect, it } from "vitest";
import {
  hasCompletionMessageSessionSpawn,
  mergeAcceptedSessionSpawnsForRun,
} from "../../accepted-session-spawn.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function makeRun(runId: string): SubagentRunRecord {
  return {
    runId,
    requesterTurnRunId: "run-requester",
    requesterTurnYielded: true,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", endedAt: 2_000 },
    expectsCompletionMessage: true,
    completion: { required: true },
    delivery: { status: "delivered" },
    cleanupCompletedAt: 2_500,
  };
}

function authority() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    assertCurrent: () => {},
    release: () => {},
  } as unknown as Parameters<typeof subagentRuns.bindCompletionAuthority>[1];
}

afterEach(() => subagentRuns.clear());

describe("completion custody receipt retirement", () => {
  it.each([
    { removed: true, owed: false },
    { removed: false, owed: true },
  ])("retires the accepted receipt only on committed removal: %j", ({ removed, owed }) => {
    const entry = makeRun(removed ? "cleaned" : "retained");
    const instance: OperationalRunInstanceRef = {
      instanceId: `i-${entry.runId}`,
      runId: "run-requester",
    };
    mergeAcceptedSessionSpawnsForRun(instance, [
      {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        expectsCompletionMessage: true,
      },
    ]);
    subagentRuns.set(entry.runId, entry);
    subagentRuns.bindCompletionAuthority(entry, authority(), instance);
    subagentRuns.settleCompletionAuthorities(
      removed ? new Map() : new Map([[entry.runId, { ...entry, cleanupCompletedAt: undefined }]]),
    );
    expect(hasCompletionMessageSessionSpawn(mergeAcceptedSessionSpawnsForRun(instance))).toBe(owed);
  });
});
