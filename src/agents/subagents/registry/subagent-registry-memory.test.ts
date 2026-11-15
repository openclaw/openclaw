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
  getSubagentActivationRuns,
  getSubagentSweepRuns,
  getRecordedSubagentChildAuthority,
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  getSubagentSessionReadLookup,
  immutableSubagentRun,
  immutableSubagentRunSessionList,
  restoreSubagentRunPayload,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { createSubagentSessionListReadIndex } from "./subagent-registry-read-index.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import * as runGeneration from "./subagent-run-generation.js";
import { bindSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import {
  isSubagentRunPayloadEvicted,
  getSubagentTerminalReplySummary,
} from "./subagent-run-payload-facts.js";

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: runId,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running" },
    ...overrides,
  };
}

afterEach(() => subagentRuns.clear());

it("prepares list-owner facts once per view without lending authority to display rows or old incarnations", () => {
  const entry = createRun("shared-read-owner");
  subagentRuns.set(entry.runId, entry);
  const resident = subagentRuns.get(entry.runId)!;
  const display = immutableSubagentRunSessionList(resident);
  let identity = {};
  const copy = vi.spyOn(runGeneration, "copySubagentRunRuntimeOwner");
  const view = createSubagentSessionListReadIndex(
    {
      snapshotIdentity: () => identity,
      runs: () => new Map([[entry.runId, display]]),
      prepare: async () => {},
    },
    1,
  );
  const read = () => [...view.read(1).inputs.inMemoryRuns!][0]!;
  try {
    const first = read();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(read()).toBe(first);
    expect(first).not.toBe(display);
    expect(Object.isFrozen(first)).toBe(true);
    expect(isSameSubagentRunOwner(resident, first)).toBe(true);
    expect(isSameSubagentRunOwner(resident, display)).toBe(false);

    bindSubagentRunRuntimeKey(resident, {});
    identity = {};
    const next = read();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(next).not.toBe(first);
    expect(read()).toBe(next);
    expect(next).toEqual(first);
    expect(isSameSubagentRunOwner(resident, first)).toBe(false);
    expect(isSameSubagentRunOwner(resident, next)).toBe(true);
    expect(immutableSubagentRunSessionList(resident)).toBe(display);
    expect(isSameSubagentRunOwner(resident, display)).toBe(false);
  } finally {
    view.dispose();
    copy.mockRestore();
  }
});

describe("completed subagent payload residency", () => {
  function completedRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
    return {
      ...createRun("completed"),
      task: "Assigned task ".repeat(100),
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      cleanupCompletedAt: 3,
      expectsCompletionMessage: true,
      delivery: { status: "delivered" },
      completion: {
        required: true,
        resultText: "Complete result ".repeat(100),
        fallbackResultText: "Prior result",
        capturedAt: 2,
        terminalReply: { disposition: "visible", text: "Final reply evidence" },
      },
      ...overrides,
    };
  }

  it("releases finished payloads and hydrates text without replacing current ownership facts", () => {
    const original = completedRun();
    const resolver = () => undefined;
    bindGatewayContextResolver(original, resolver);
    immutableSubagentRun(original);
    const resident = compactSubagentRunForMemory(original);
    expect(resident.task).toBe(original.task.slice(0, 160));
    expect(resident.completion?.resultText).toBeUndefined();
    expect(resident.completion?.fallbackResultText).toBeUndefined();
    expect(resident.completion?.terminalReply).toBeUndefined();
    expect(getSubagentTerminalReplySummary(resident)).toEqual({
      disposition: "visible",
      textLength: "Final reply evidence".length,
    });
    expect(isSubagentRunPayloadEvicted(resident)).toBe(true);
    expect(compactSubagentRunForMemory(resident)).toBe(resident);

    const restored = restoreSubagentRunPayload(resident, {
      ...original,
      cleanupCompletedAt: 0,
      delivery: { status: "pending" },
    });
    expect(restored.completion).toEqual(original.completion);
    expect(restored.task).toBe(original.task);
    expect(restored.cleanupCompletedAt).toBe(3);
    expect(restored.delivery?.status).toBe("delivered");
    expect(isSubagentRunPayloadEvicted(restored)).toBe(false);
    expect(isSameSubagentRunOwner(restored, original)).toBe(true);
    expect(getGatewayContextResolver(restored)).toBe(resolver);
    expect(getGatewayContextResolver(resident)).toBe(resolver);
  });

  it("keeps settled collector payloads cold while retaining their spawning turn identity", () => {
    const entry = completedRun({
      collect: true,
      requesterTurnRunId: "parent-turn",
      expectsCompletionMessage: false,
      completion: { required: false, resultText: "collected result", capturedAt: 2 },
      delivery: { status: "not_required" },
    });
    const resident = compactSubagentRunForMemory(entry);
    subagentRuns.set(entry.runId, resident);
    expect(resident.requesterTurnRunId).toBe("parent-turn");
    expect(isSubagentRunPayloadEvicted(resident)).toBe(true);
    expect([...getSubagentActivationRuns(subagentRuns)]).toEqual([]);
    expect(restoreSubagentRunPayload(resident, entry).completion?.resultText).toBe(
      "collected result",
    );
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
    const entry = completedRun(unfinished);
    expect(compactSubagentRunForMemory(entry)).toBe(entry);
    expect(isSubagentRunPayloadEvicted(entry)).toBe(false);
  });
});

describe("subagent run memory indexes", () => {
  it("reuses captured child links across run-state changes and retires them on an ownership move", () => {
    const first = createRun("first");
    const second = createRun("second");
    subagentRuns.set(first.runId, first);
    subagentRuns.set(second.runId, second);
    const lookup = getSubagentSessionReadLookup(subagentRuns);
    const links = lookup.captureTopology();
    expect(links).toEqual([
      { childSessionKey: first.childSessionKey, requesterSessionKey: "agent:main:main" },
      { childSessionKey: second.childSessionKey, requesterSessionKey: "agent:main:main" },
    ]);
    for (const status of ["queued", "running", "terminal"] as const) {
      subagentRuns.set(first.runId, { ...first, execution: { status } });
      expect(lookup.captureTopology()).toBe(links);
    }
    subagentRuns.set(first.runId, { ...first, requesterSessionKey: "agent:main:moved" });
    expect(lookup.captureTopology()).toEqual([
      { childSessionKey: first.childSessionKey, requesterSessionKey: "agent:main:moved" },
      { childSessionKey: second.childSessionKey, requesterSessionKey: "agent:main:main" },
    ]);
    expect(links[0]?.requesterSessionKey).toBe("agent:main:main");
    subagentRuns.delete(second.runId);
    expect(lookup.captureTopology()).toEqual([
      { childSessionKey: first.childSessionKey, requesterSessionKey: "agent:main:moved" },
    ]);
  });

  it("selects unfinished work and due retention across replacement, deletion, and reset", () => {
    const history = createRun("history", {
      execution: { status: "terminal", endedAt: 2 },
      cleanupCompletedAt: 3,
      delivery: { status: "delivered" },
    });
    const archive = { ...history, runId: "archive", archiveAtMs: 100 };
    const session = { ...history, runId: "session", spawnMode: "session" as const };
    const pending = { ...history, runId: "pending", delivery: { status: "pending" as const } };
    for (const entry of [history, archive, session, pending]) {
      subagentRuns.set(entry.runId, immutableSubagentRun(entry));
    }
    const candidates = (now: number) =>
      [...getSubagentSweepRuns(subagentRuns, now)].map((entry) => entry.runId);
    expect(candidates(99)).toEqual(["pending"]);
    expect(candidates(100)).toEqual(["pending", "archive"]);
    subagentRuns.set("archive", immutableSubagentRun({ ...archive, archiveAtMs: 200 }));
    expect(candidates(150)).toEqual(["pending"]);
    subagentRuns.set("archive", immutableSubagentRun({ ...archive, archiveAtMs: 151 }));
    expect(candidates(151)).toEqual(["pending", "archive"]);
    subagentRuns.delete("archive");
    subagentRuns.set("pending", immutableSubagentRun({ ...history, runId: "pending" }));
    expect(candidates(300_003)).toEqual([]);
    expect(candidates(300_004)).toEqual(["session"]);
    subagentRuns.set(
      "history",
      immutableSubagentRun({ ...history, execution: { status: "running" } }),
    );
    expect(candidates(300_005)).toEqual(["session", "history"]);
    subagentRuns.clear();
    expect(candidates(Infinity)).toEqual([]);
  });

  it("prepares child identity per immutable row without carrying it into changed ownership", () => {
    const entry = immutableSubagentRun(
      createRun("identity", {
        childSessionIdentity: { sessionId: "child", lifecycleRevision: "revision" },
      }),
    );
    expect(getRecordedSubagentChildAuthority(entry)).toEqual({
      status: "verified",
      childAgentId: "main",
      requesterAgentId: "main",
      sessionIdentity: { sessionId: "child", lifecycleRevision: "revision" },
    });
    const changed = immutableSubagentRun({ ...entry, childAgentId: "other" });
    expect(getRecordedSubagentChildAuthority(changed).status).toBe("mismatch");
    expect(getRecordedSubagentChildAuthority(entry).status).toBe("verified");
  });

  it("tracks activation obligations across settlement, reactivation, deletion, and reset", () => {
    const finished = createRun("history", {
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
      cleanupCompletedAt: 3,
    });
    const running = createRun("running");
    const cleanup = { ...finished, runId: "cleanup", cleanupCompletedAt: undefined };
    const wake: SubagentRunRecord = {
      ...finished,
      runId: "wake",
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    };
    for (const entry of [finished, running, cleanup, wake]) {
      subagentRuns.set(entry.runId, entry);
    }
    const candidates = () => [...getSubagentActivationRuns(subagentRuns)].map((run) => run.runId);
    expect(candidates()).toEqual(["running", "cleanup", "wake"]);
    subagentRuns.set(running.runId, {
      ...running,
      execution: finished.execution,
      cleanupCompletedAt: 3,
    });
    subagentRuns.set(wake.runId, { ...wake, requesterSettleWake: undefined });
    subagentRuns.delete(cleanup.runId);
    subagentRuns.set(finished.runId, { ...finished, execution: { status: "running" } });
    expect(candidates()).toEqual(["history"]);
    subagentRuns.clear();
    expect(candidates()).toEqual([]);
  });

  it.each([
    ["global", "unresolved"],
    ["agent:main:subagent:shared", "unresolved"],
    ["global", "replacement"],
    ["agent:main:subagent:shared", "replacement"],
  ])("preserves collector authorization for %s with %s rows", (childSessionKey, scenario) => {
    const first = createRun("collector-first", {
      childSessionKey,
      childAgentId: "main",
      collect: true,
      swarmLaunchIdempotencyKey: "launch-first",
    });
    const second = {
      ...first,
      runId: "collector-second",
      swarmLaunchIdempotencyKey: "launch-second",
      childAgentId:
        scenario === "replacement" ? "main" : childSessionKey === "global" ? undefined : "research",
    };
    const selected = scenario === "unresolved" ? first : second;
    const latest = () =>
      getLatestLiveSubagentRunByChildSessionKey(childSessionKey, undefined, "MAIN");
    const authorize = () =>
      findAuthorizedSwarmCollectorRequest({
        childSessionKey,
        childAgentId: scenario === "unresolved" ? "MAIN" : "main",
        idempotencyKey: selected.swarmLaunchIdempotencyKey,
      });
    subagentRuns.set(first.runId, first);
    subagentRuns.set(second.runId, second);
    expect(authorize()).toEqual(selected);
    expect(latest()).toEqual(selected);
    expect(
      getLatestLiveSubagentRunByChildSessionKey(
        childSessionKey,
        (run) => run.runId === first.runId,
        "main",
      ),
    ).toEqual(first);
    if (scenario === "unresolved") {
      expect([...getSubagentRunsForChildSession(childSessionKey, "main")]).toEqual([first]);
      expect([...getSubagentChildSessionCandidates(childSessionKey)]).toEqual([first, second]);
      expect(subagentRuns.get(second.runId)).toBe(second);
      return;
    }

    subagentRuns.set(first.runId, { ...first, collect: false });
    expect(authorize()).toEqual(second);

    subagentRuns.set(first.runId, first);
    expect(latest()).toEqual(second);
    subagentRuns.delete(first.runId);
    expect(authorize()).toEqual(second);
    expect(latest()).toEqual(second);

    subagentRuns.clear();
    expect(authorize()).toBeUndefined();
    expect(latest()).toBeNull();
  });

  it("tracks distinct scheduler slot aliases across replacement and deletion", () => {
    const first = createRun("run-first", {
      swarmRunId: "collector-first",
      schedulerSlotId: "slot-first",
    });
    subagentRuns.set(first.runId, first);
    const lookup = getSubagentSessionReadLookup(subagentRuns);
    const select = (...ids: string[]) => lookup.selectRunIds(new Set(ids));
    expect(select("slot-first")).toEqual([first.runId]);
    expect(select(first.runId, "collector-first", "slot-first")).toEqual([first.runId]);

    const replacement = { ...first, schedulerSlotId: "slot-replacement" };
    subagentRuns.set(replacement.runId, replacement);
    expect(select("slot-first")).toEqual([]);
    expect(select(replacement.schedulerSlotId)).toEqual([replacement.runId]);

    subagentRuns.delete(replacement.runId);
    expect(select(replacement.runId, "collector-first", replacement.schedulerSlotId)).toEqual([]);
  });

  it("retains a selected registration through its own ACK but rejects a current replacement", () => {
    const entry = createRun("selected");
    subagentRuns.set(entry.runId, entry);
    const selected = subagentRuns.captureRegistrationOwnership(entry.childSessionKey, entry);
    try {
      selected.accept(entry);
      expect(selected.assertCurrent).not.toThrow();
      expect(selected.superseded).toBe(false);
      const replacement = createRun(entry.runId, { generation: 1 });
      subagentRuns.set(entry.runId, replacement);
      subagentRuns.commitOwnership(replacement);
      expect(selected.assertCurrent).toThrow("owner changed");
      expect(selected.superseded).toBe(true);
    } finally {
      selected.release();
    }
  });

  it("publishes accepted ownership and retirement without exposing provisional map writes", () => {
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    const entry = createRun("accepted");
    const notice = { sessionKey: entry.childSessionKey, scope: "runtime" };
    try {
      subagentRuns.set(entry.runId, entry);
      expect(changed).not.toHaveBeenCalled();
      subagentRuns.commitOwnership(entry);
      expect(changed.mock.calls).toEqual([[notice]]);
      changed.mockClear();
      subagentRuns.delete(entry.runId);
      expect(changed).not.toHaveBeenCalled();
      subagentRuns.confirmRetirement(entry);
      expect(changed.mock.calls).toEqual([[notice]]);
      changed.mockClear();
      subagentRuns.clear();
      expect(changed.mock.calls).toEqual([[{ all: true, scope: "subagent-runs" }]]);
    } finally {
      stop();
    }
  });

  it.each(["child session", "collector group"])(
    "tracks %s replacement, deletion, and clear",
    (kind) => {
      const requesterSessionKey = "agent:main:requester";
      const isGroup = kind === "collector group";
      const first = createRun("run-first", {
        childSessionKey: "agent:main:subagent:shared",
        requesterSessionKey,
        collect: true,
        groupId: "swarm:shared",
        collectorCompletion: { status: "done" },
      });
      const second = { ...first, runId: "run-second", collectorCompletion: undefined };
      const select = (run: SubagentRunRecord) =>
        isGroup
          ? [...getSubagentRunsForCollectorGroup(requesterSessionKey, run.groupId!)]
          : [...getSubagentRunsForChildSession(run.childSessionKey)];
      const expected = (...runs: SubagentRunRecord[]) =>
        isGroup ? runs.map((run) => [run.runId, run]) : runs;
      subagentRuns.set(first.runId, first);
      subagentRuns.set(second.runId, second);
      expect(select(first)).toEqual(expected(first, second));

      const updated = { ...first, execution: { status: "terminal" as const, endedAt: 2 } };
      subagentRuns.set(updated.runId, updated);
      expect(select(updated)).toEqual(expected(second, updated));

      const replacement = {
        ...first,
        [isGroup ? "groupId" : "childSessionKey"]: "agent:main:replacement",
      };
      subagentRuns.set(replacement.runId, replacement);
      expect(select(first)).toEqual(expected(second));
      expect(select(replacement)).toEqual(expected(replacement));
      subagentRuns.delete(second.runId);
      expect(select(first)).toEqual([]);
      subagentRuns.clear();
      expect(select(replacement)).toEqual([]);
    },
  );
});
