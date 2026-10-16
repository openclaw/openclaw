import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import {
  findAuthorizedSwarmCollectorRequest,
  compactSubagentRunForMemory,
  getSubagentChildSessionCandidates,
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  getSubagentSessionReadLookup,
  immutableSubagentRun,
  isSubagentRunPayloadEvicted,
  restoreSubagentRunPayload,
  subagentRuns,
} from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";

function createRun(runId: string, childSessionKey: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running" },
  };
}

afterEach(() => {
  subagentRuns.clear();
});

describe("completed subagent payload residency", () => {
  function completedRun(): SubagentRunRecord {
    return {
      ...createRun("completed", "agent:main:subagent:completed"),
      task: "Assigned task ".repeat(100),
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      cleanupCompletedAt: 3,
      delivery: { status: "delivered" },
      completion: {
        required: true,
        resultText: "Complete result ".repeat(100),
        fallbackResultText: "Prior result",
        capturedAt: 2,
        terminalReply: { disposition: "visible", text: "Final reply evidence" },
      },
    };
  }

  it("releases finished payloads and hydrates text without replacing current ownership facts", () => {
    const original = completedRun();
    const resolver = () => undefined;
    bindGatewayContextResolver(original, resolver);
    immutableSubagentRun(original);
    const resident = compactSubagentRunForMemory(original);
    expect(resident.task).toHaveLength(160);
    expect(resident.task).toBe(original.task.slice(0, 160));
    expect(resident.completion?.resultText).toBeUndefined();
    expect(resident.completion?.fallbackResultText).toBeUndefined();
    expect(resident.completion?.terminalReply).toEqual({
      disposition: "visible",
      text: "Final reply evidence",
    });
    expect(isSubagentRunPayloadEvicted(resident)).toBe(true);
    expect(compactSubagentRunForMemory(resident)).toBe(resident);

    const restored = restoreSubagentRunPayload(resident, {
      ...original,
      cleanupCompletedAt: 0,
      delivery: { status: "pending" },
    });
    expect(restored.task).toBe(original.task);
    expect(restored.completion).toEqual(original.completion);
    expect(restored.cleanupCompletedAt).toBe(3);
    expect(restored.delivery?.status).toBe("delivered");
    expect(isSubagentRunPayloadEvicted(restored)).toBe(false);
    expect(isSameSubagentRunOwner(restored, original)).toBe(true);
    expect(getGatewayContextResolver(restored)).toBe(resolver);
    expect(getGatewayContextResolver(resident)).toBe(resolver);
  });

  it.each<[string, Partial<SubagentRunRecord>]>([
    ["running", { execution: { status: "running" } }],
    ["unfinished cleanup", { cleanupCompletedAt: undefined }],
    ["spawning parent turn", { requesterTurnRunId: "parent-turn" }],
    ["requester wake", { requesterSettleWake: { status: "pending", attemptCount: 0 } }],
    ["yielded child", { pauseReason: "sessions_yield" }],
    ["kill intent", { killIntent: { requestedAt: 2, reason: "cancel" } }],
    ["kill reconciliation", { killReconciliation: { killedAt: 2 } }],
    ["collector cleanup", { collectorLaunchCleanupPending: true }],
    ["pending delivery", { delivery: { status: "pending" } }],
    ["in-flight delivery", { delivery: { status: "in_progress" } }],
    ["suspended delivery", { delivery: { status: "suspended", suspendedAt: 2 } }],
  ])("keeps payloads while %s owns unfinished work", (_name, unfinished) => {
    const entry = { ...completedRun(), ...unfinished };
    expect(compactSubagentRunForMemory(entry)).toBe(entry);
    expect(isSubagentRunPayloadEvicted(entry)).toBe(false);
  });
});

describe("subagent run memory indexes", () => {
  it.each(["global", "agent:main:subagent:shared"])(
    "retains collector authorization beside unresolved rows (%s)",
    (childSessionKey) => {
      const collector = {
        ...createRun("collector-owned", childSessionKey),
        childAgentId: "main",
        collect: true,
        swarmLaunchIdempotencyKey: "launch-owned",
      };
      const retained = {
        ...collector,
        runId: "collector-unresolved",
        childAgentId: childSessionKey === "global" ? undefined : "research",
      };
      subagentRuns.set(collector.runId, collector);
      subagentRuns.set(retained.runId, retained);
      expect(
        findAuthorizedSwarmCollectorRequest({
          childSessionKey,
          childAgentId: "MAIN",
          idempotencyKey: collector.swarmLaunchIdempotencyKey,
        }),
      ).toEqual(collector);
      expect([...getSubagentRunsForChildSession(childSessionKey, "main")]).toEqual([collector]);
      expect([...getSubagentChildSessionCandidates(childSessionKey)]).toEqual([
        collector,
        retained,
      ]);
      expect(subagentRuns.get(retained.runId)).toBe(retained);
    },
  );

  it.each(["global", "agent:main:subagent:shared"])(
    "preserves collector authorization across replacement and retirement (%s)",
    (childSessionKey) => {
      const first = {
        ...createRun("collector-first", childSessionKey),
        childAgentId: "main",
        collect: true,
        swarmLaunchIdempotencyKey: "launch-first",
      };
      const second = {
        ...first,
        runId: "collector-second",
        swarmLaunchIdempotencyKey: "launch-second",
      };
      const authorizeSecond = () =>
        findAuthorizedSwarmCollectorRequest({
          childSessionKey,
          childAgentId: "main",
          idempotencyKey: second.swarmLaunchIdempotencyKey,
        });
      subagentRuns.set(first.runId, first);
      subagentRuns.set(second.runId, second);
      expect(authorizeSecond()).toEqual(second);

      subagentRuns.set(first.runId, { ...first, collect: false });
      expect(authorizeSecond()).toEqual(second);

      subagentRuns.set(first.runId, first);
      subagentRuns.delete(first.runId);
      expect(authorizeSecond()).toEqual(second);

      subagentRuns.clear();
      expect(authorizeSecond()).toBeUndefined();
    },
  );

  it("tracks distinct scheduler slot aliases across replacement and deletion", () => {
    const first = {
      ...createRun("run-first", "agent:main:subagent:first"),
      swarmRunId: "collector-first",
      schedulerSlotId: "slot-first",
    };
    subagentRuns.set(first.runId, first);
    const lookup = getSubagentSessionReadLookup(subagentRuns);
    expect(lookup.selectRunIds(new Set([first.schedulerSlotId]))).toEqual([first.runId]);
    expect(
      lookup.selectRunIds(new Set([first.runId, first.swarmRunId, first.schedulerSlotId])),
    ).toEqual([first.runId]);

    const replacement = { ...first, schedulerSlotId: "slot-replacement" };
    subagentRuns.set(replacement.runId, replacement);
    expect(lookup.selectRunIds(new Set([first.schedulerSlotId]))).toEqual([]);
    expect(lookup.selectRunIds(new Set([replacement.schedulerSlotId]))).toEqual([
      replacement.runId,
    ]);

    subagentRuns.delete(replacement.runId);
    expect(
      lookup.selectRunIds(
        new Set([replacement.runId, replacement.swarmRunId, replacement.schedulerSlotId]),
      ),
    ).toEqual([]);
  });

  it("retains a selected registration through its own ACK but rejects a committed replacement ABA", () => {
    const entry = createRun("selected", "agent:main:subagent:selected");
    subagentRuns.set(entry.runId, entry);
    const selected = subagentRuns.captureRegistrationOwnership(entry.childSessionKey, entry);
    const preparing = subagentRuns.captureRegistrationOwnership(entry.childSessionKey);
    try {
      selected.accept(entry);
      expect(selected.assertCurrent).not.toThrow();
      expect(selected.superseded).toBe(false);
      expect(preparing.assertCurrent).toThrow("owner changed");
      expect(() => preparing.accept(entry)).toThrow("owner changed");
      const replacement = createRun(entry.runId, entry.childSessionKey);
      replacement.generation = 1;
      subagentRuns.set(entry.runId, replacement);
      subagentRuns.commitOwnership(replacement);
      expect(selected.assertCurrent).toThrow("owner changed");
      expect(selected.superseded).toBe(true);
      subagentRuns.delete(replacement.runId);
      subagentRuns.confirmRetirement(replacement);
      subagentRuns.set(entry.runId, entry);
      subagentRuns.commitOwnership(entry);
      expect(selected.assertCurrent).toThrow("owner changed");
    } finally {
      selected.release();
      preparing.release();
    }
  });

  it("publishes accepted ownership and retirement without exposing provisional map writes", () => {
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    const entry = createRun("accepted", "agent:main:subagent:accepted");
    try {
      subagentRuns.set(entry.runId, entry);
      expect(changed).not.toHaveBeenCalled();
      subagentRuns.commitOwnership(entry);
      expect(changed.mock.calls).toEqual([
        [{ sessionKey: entry.childSessionKey, scope: "runtime" }],
      ]);
      changed.mockClear();
      subagentRuns.delete(entry.runId);
      expect(changed).not.toHaveBeenCalled();
      subagentRuns.confirmRetirement(entry);
      expect(changed.mock.calls).toEqual([
        [{ sessionKey: entry.childSessionKey, scope: "runtime" }],
      ]);
      changed.mockClear();
      subagentRuns.clear();
      expect(changed.mock.calls).toEqual([[{ all: true, scope: "subagent-runs" }]]);
    } finally {
      stop();
    }
  });

  it("tracks child-session generations across replacement, deletion, and clear", () => {
    const first = createRun("run-first", "agent:main:subagent:shared");
    const second = createRun("run-second", "agent:main:subagent:shared");
    subagentRuns.set(first.runId, first);
    subagentRuns.set(second.runId, second);

    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([first, second]);

    const replacement = createRun("run-first", "agent:main:subagent:replacement");
    subagentRuns.set(replacement.runId, replacement);
    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([second]);
    expect([...getSubagentRunsForChildSession(replacement.childSessionKey)]).toEqual([replacement]);

    subagentRuns.delete(second.runId);
    expect([...getSubagentRunsForChildSession(first.childSessionKey)]).toEqual([]);

    subagentRuns.clear();
    expect([...getSubagentRunsForChildSession(replacement.childSessionKey)]).toEqual([]);
  });

  it("tracks every collector group member across replacement, deletion, and clear", () => {
    const requesterSessionKey = "agent:main:requester";
    const first = {
      ...createRun("run-first", "agent:main:subagent:first"),
      requesterSessionKey,
      collect: true,
      groupId: "swarm:shared",
      collectorCompletion: { status: "done" as const },
    };
    const incomplete = {
      ...createRun("run-incomplete", "agent:main:subagent:incomplete"),
      requesterSessionKey,
      collect: true,
      groupId: "swarm:shared",
    };
    subagentRuns.set(first.runId, first);
    subagentRuns.set(incomplete.runId, incomplete);

    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([
      [first.runId, first],
      [incomplete.runId, incomplete],
    ]);

    const replacement = { ...first, groupId: "swarm:replacement" };
    subagentRuns.set(replacement.runId, replacement);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([
      [incomplete.runId, incomplete],
    ]);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:replacement")]).toEqual(
      [[replacement.runId, replacement]],
    );

    subagentRuns.delete(incomplete.runId);
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:shared")]).toEqual([]);

    subagentRuns.clear();
    expect([...getSubagentRunsForCollectorGroup(requesterSessionKey, "swarm:replacement")]).toEqual(
      [],
    );
  });
});
