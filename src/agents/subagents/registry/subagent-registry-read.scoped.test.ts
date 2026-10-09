import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAcpTurnActive } from "../../../acp/control-plane/active-turns.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { countUntrackedActiveAcpRunsForOwner } from "../spawn/acp-spawn-admission.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  countActiveDescendantRunsFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => {
  const liveRuns = new Map<string, SubagentRunRecord>();
  return {
    liveRuns,
    readSnapshot: new Map<string, SubagentRunRecord>(),
    getSubagentRunsForChildSession: vi.fn<(childSessionKey: string) => Iterable<SubagentRunRecord>>(
      () => [],
    ),
    getSubagentSessionListRunsSnapshotForRead: vi.fn<
      (runs: Map<string, SubagentRunRecord>) => Map<string, SubagentRunRecord>
    >(() => new Map()),
    getSubagentSessionListRunsSnapshotForChildSessions: vi.fn<
      (keys: readonly string[]) => Map<string, SubagentRunReadRecord>
    >(() => new Map()),
    getSubagentRunsSnapshotForChildSession: vi.fn<
      typeof import("./subagent-registry-state.js").getSubagentRunsSnapshotForChildSession
    >(async () => new Map()),
    getSubagentRunsSnapshotForRead: vi.fn<
      (runs: Map<string, SubagentRunRecord>) => Map<string, SubagentRunRecord>
    >(() => {
      throw new Error("unexpected full registry hydration");
    }),
  };
});

vi.mock("./subagent-registry-memory.js", () => ({
  getSubagentRunsForChildSession: mocks.getSubagentRunsForChildSession,
  subagentRuns: mocks.liveRuns,
}));

// mock-isolation: Scoped reads consume fixture snapshots without opening the shared-state worker.
vi.mock("./subagent-registry-state.js", () => ({
  getSubagentSessionListRunsSnapshotForRead: mocks.getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForChildSessions:
    mocks.getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  withSubagentRunReadSnapshot: (async (_runs, select, consume) => {
    const selected = select(mocks.readSnapshot);
    return consume(
      selected,
      new Map([...mocks.readSnapshot].filter(([runId]) => selected.runIds.includes(runId))),
    );
  }) satisfies typeof withSubagentRunReadSnapshot,
}));

function createRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run";
  const { execution = { status: "running" }, ...recordOverrides } = overrides;
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "keep",
    createdAt: 1,
    ...recordOverrides,
    execution,
  };
}

describe("subagent registry scoped reads", () => {
  let mod: typeof import("./subagent-registry-read.js");

  beforeEach(async () => {
    mocks.liveRuns.clear();
    mocks.readSnapshot.clear();
    mocks.getSubagentRunsForChildSession.mockReset().mockReturnValue([]);
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReset().mockReturnValue(new Map());
    mocks.getSubagentSessionListRunsSnapshotForChildSessions.mockReset().mockReturnValue(new Map());
    mocks.getSubagentRunsSnapshotForChildSession.mockReset().mockResolvedValue(new Map());
    mocks.getSubagentRunsSnapshotForRead.mockReset().mockImplementation(() => {
      throw new Error("unexpected full registry hydration");
    });
    mod = await import("./subagent-registry-read.js");
  });

  it("uses scoped snapshots for latest lookup and compact display without full hydration", async () => {
    const childSessionKey = "agent:main:subagent:child";
    const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
    const latest = createRun({ runId: "latest", childSessionKey, generation: 2, createdAt: 100 });
    mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(
      new Map([
        [older.runId, older],
        [latest.runId, latest],
      ]),
    );
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(
      new Map([
        [older.runId, older],
        [latest.runId, latest],
      ]),
    );

    expect(await mod.getLatestSubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
    expect(mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey)).toEqual(
      latest,
    );
    expect(mocks.getSubagentRunsSnapshotForChildSession).toHaveBeenCalledOnce();
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it.each([
    {
      storePath: undefined,
      ids: ["a", "b", "unknown"],
      active: 3,
      excluded: "grandchild",
      waiting: true,
    },
    { storePath: null, ids: ["unknown"], active: 1, excluded: "unknown", waiting: false },
    { storePath: "store-a", ids: ["a"], active: 1, excluded: "grandchild", waiting: false },
    { storePath: "store-b", ids: ["b"], active: 1, excluded: "b", waiting: false },
  ])(
    "scopes requester root edges to $storePath while retaining child-agent descendants",
    ({ storePath, ids, active, excluded, waiting }) => {
      const root = "agent:main:root";
      const parent = createRun({
        runId: "a",
        childSessionKey: "agent:research:subagent:a",
        requesterSessionKey: root,
        requesterAgentId: "main",
        requesterStorePath: "store-a",
        execution: { status: "terminal", endedAt: 100 },
        cleanupCompletedAt: 200,
      });
      const runs = [
        parent,
        createRun({
          runId: "b",
          requesterSessionKey: root,
          requesterAgentId: "main",
          requesterStorePath: "store-b",
        }),
        createRun({ runId: "unknown", requesterSessionKey: root, requesterAgentId: "main" }),
        createRun({
          runId: "grandchild",
          requesterSessionKey: parent.childSessionKey,
          requesterAgentId: "research",
          requesterStorePath: "research-store",
        }),
        createRun({
          runId: "other-agent",
          requesterSessionKey: root,
          requesterAgentId: "other",
          requesterStorePath: "store-a",
        }),
      ];
      for (const run of runs) {
        mocks.liveRuns.set(run.runId, run);
      }
      expect(
        mod
          .listSubagentRunsForRequester(root, {
            requesterAgentId: "main",
            requesterStorePath: storePath,
          })
          .map((run) => run.runId),
      ).toEqual(ids);
      expect(countActiveDescendantRunsFromRuns(mocks.liveRuns, root, "main", storePath)).toBe(
        active,
      );
      expect(
        hasDescendantRunAwaitingSettleFromRuns(mocks.liveRuns, root, excluded, "main", storePath),
      ).toBe(waiting);
    },
  );

  it("keeps the latest raw live generation authoritative in compact display", () => {
    const childSessionKey = "agent:main:subagent:child";
    const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
    const latest = createRun({ runId: "latest", childSessionKey, generation: 2, createdAt: 100 });
    mocks.liveRuns.set(older.runId, older);
    mocks.liveRuns.set(latest.runId, latest);

    expect(mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey)).toBe(
      latest,
    );
    expect(mocks.getSubagentRunsSnapshotForChildSession).not.toHaveBeenCalled();
  });

  it("keeps an older live ACP child tracked despite newer terminal history", () => {
    const childSessionKey = "agent:main:acp:capacity-child";
    const ownerKey = "agent:main:subagent:capacity-owner";
    const older = createRun({
      runId: "capacity-active",
      childSessionKey,
      requesterSessionKey: ownerKey,
      generation: 1,
      createdAt: Date.now() - 3 * 60 * 60_000,
    });
    const latest = createRun({
      runId: "capacity-terminal",
      childSessionKey,
      requesterSessionKey: ownerKey,
      generation: 2,
      createdAt: Date.now(),
      execution: { status: "terminal", endedAt: Date.now() },
    });
    mocks.liveRuns.set(older.runId, older);
    mocks.liveRuns.set(latest.runId, latest);
    mocks.getSubagentSessionListRunsSnapshotForChildSessions.mockReturnValue(
      new Map([older, latest].map((row) => [row.runId, projectSubagentRunForSessionList(row)])),
    );
    const claim = claimAgentRunContext(
      older.runId,
      { sessionKey: childSessionKey },
      { trackOwner: true, ownsContext: true },
    );
    const releaseTurn = markAcpTurnActive({
      agentId: "main",
      sessionKey: childSessionKey,
      ownerSessionKey: ownerKey,
    });
    try {
      expect(countUntrackedActiveAcpRunsForOwner(ownerKey)).toBe(0);
      releaseAgentRunContext(older.runId, claim);
      expect(countUntrackedActiveAcpRunsForOwner(ownerKey)).toBe(1);
      expect(countUntrackedActiveAcpRunsForOwner(ownerKey, new Set([childSessionKey]))).toBe(0);
      expect(mocks.getSubagentRunsSnapshotForChildSession).not.toHaveBeenCalled();
      expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
    } finally {
      releaseTurn?.();
      releaseAgentRunContext(older.runId, claim);
    }
  });

  it.each(["requester", "completion"] as const)(
    "reads %s announcement facts from the child snapshot without full hydration",
    async (kind) => {
      const childSessionKey = "agent:main:subagent:child";
      const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
      const latest = createRun({
        runId: "latest",
        childSessionKey,
        generation: 2,
        createdAt: 100,
        requesterSessionKey: "agent:main:requester",
        requesterAgentId: "main",
        requesterOrigin: { channel: "discord", to: " room " },
        execution: { status: "terminal", endedAt: 300 },
        cleanupCompletedAt: 400,
      });
      mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(
        new Map([
          [older.runId, older],
          [latest.runId, latest],
        ]),
      );

      if (kind === "requester") {
        expect(await mod.resolveRequesterForChildSession(childSessionKey)).toEqual({
          requesterSessionKey: "agent:main:requester",
          requesterAgentId: "main",
          requesterOrigin: { channel: "discord", to: "room" },
        });
      } else {
        expect(await mod.shouldIgnorePostCompletionAnnounceForSession(childSessionKey)).toBe(true);
      }
      expect(mocks.getSubagentRunsSnapshotForChildSession).toHaveBeenCalledWith(
        mocks.liveRuns,
        childSessionKey,
        undefined,
      );
      expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
    },
  );

  it("selects live controller roots while retaining legacy requester-owned runs", () => {
    const controllerSessionKey = "agent:main:controller";
    const explicit = createRun({
      runId: "explicit",
      controllerSessionKey,
      requesterSessionKey: "agent:main:other",
    });
    const legacy = createRun({ runId: "legacy", requesterSessionKey: controllerSessionKey });
    const other = createRun({
      runId: "other",
      controllerSessionKey: "agent:main:other-controller",
      requesterSessionKey: controllerSessionKey,
    });
    for (const entry of [explicit, legacy, other]) {
      mocks.liveRuns.set(entry.runId, entry);
    }
    expect(listRunsForControllerFromRuns(mocks.liveRuns, controllerSessionKey)).toEqual([
      explicit,
      legacy,
    ]);
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it.each(["delivered", "intentional_non_delivery", "permanent_failure", "ambiguous"] as const)(
    "reads %s settlement and descendant counts without hydrating unrelated payloads",
    async (disposition) => {
      const root = "agent:main:root";
      const run = createRun({
        requesterSessionKey: root,
        requesterAgentId: "main",
        execution: { status: "terminal", endedAt: 100 },
        delivery: { status: "pending", disposition },
      });
      mocks.readSnapshot.set(run.runId, run);
      expect(countActiveDescendantRunsFromRuns(mocks.readSnapshot, root, "main")).toBe(0);
      expect(await mod.countPendingDescendantRuns(root, () => {})).toBe(1);
      expect(
        hasDescendantRunAwaitingSettleFromRuns(mocks.readSnapshot, root, undefined, "main"),
      ).toBe(disposition === "ambiguous");
      expect(
        hasDescendantRunAwaitingSettleFromRuns(mocks.readSnapshot, root, run.runId, "main"),
      ).toBe(false);
      expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
    },
  );

  it("keeps every bound read equivalent to its documented snapshot scope", async () => {
    const now = Date.now();
    const root = "agent:main:root";
    const controller = "agent:main:controller";
    const reusedChild = "agent:main:subagent:reused";
    const parent = "agent:main:subagent:parent";
    const pendingChild = "agent:main:subagent:pending";
    const settledChild = "agent:main:subagent:settled";
    const suspendedChild = "agent:main:subagent:suspended";
    const oldActive = createRun({
      runId: "run-reused-active",
      childSessionKey: reusedChild,
      requesterSessionKey: root,
      controllerSessionKey: controller,
      generation: 1,
      createdAt: now - 5_000,
      execution: { status: "running", startedAt: now - 4_900 },
    });
    const freshTerminal = createRun({
      runId: "run-reused-terminal",
      childSessionKey: reusedChild,
      requesterSessionKey: root,
      requesterOrigin: { channel: "discord", to: " room " },
      controllerSessionKey: controller,
      generation: 2,
      createdAt: now - 4_000,
      spawnMode: "run",
      cleanupCompletedAt: now - 1_000,
      execution: { status: "terminal", startedAt: now - 3_900, endedAt: now - 2_000 },
    });
    const parentRun = createRun({
      runId: "run-parent",
      childSessionKey: parent,
      requesterSessionKey: root,
      requesterAgentId: "main",
      controllerSessionKey: controller,
      createdAt: now - 3_000,
      execution: { status: "running", startedAt: now - 2_900 },
    });
    const foreignActive = createRun({
      runId: "run-foreign-active",
      childSessionKey: "agent:research:subagent:foreign",
      requesterSessionKey: root,
      requesterAgentId: "research",
      createdAt: now - 2_500,
      execution: { status: "running", startedAt: now - 2_400 },
    });
    const pendingRun = createRun({
      runId: "run-pending",
      childSessionKey: pendingChild,
      requesterSessionKey: parent,
      createdAt: now - 2_000,
      execution: { status: "terminal", startedAt: now - 1_900, endedAt: now - 1_500 },
    });
    const settledRun = createRun({
      runId: "run-settled",
      childSessionKey: settledChild,
      requesterSessionKey: parent,
      createdAt: now - 1_800,
      cleanupCompletedAt: now - 1_200,
      execution: { status: "terminal", startedAt: now - 1_700, endedAt: now - 1_300 },
    });
    const suspendedRun = createRun({
      runId: "run-suspended",
      childSessionKey: suspendedChild,
      requesterSessionKey: parent,
      createdAt: now - 1_600,
      delivery: { status: "suspended", disposition: "permanent_failure" },
      execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_100 },
    });
    const snapshot = new Map(
      [
        oldActive,
        freshTerminal,
        parentRun,
        foreignActive,
        pendingRun,
        settledRun,
        suspendedRun,
      ].map((run) => [run.runId, run] as const),
    );
    const childSnapshot = new Map(
      [oldActive, freshTerminal].map((run) => [run.runId, run] as const),
    );
    mocks.liveRuns.set(freshTerminal.runId, freshTerminal);
    mocks.liveRuns.set(parentRun.runId, parentRun);
    mocks.getSubagentRunsForChildSession.mockImplementation((childSessionKey) =>
      [...mocks.liveRuns.values()].filter((run) => run.childSessionKey === childSessionKey),
    );
    mocks.getSubagentRunsSnapshotForRead.mockReturnValue(snapshot);
    mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(childSnapshot);
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(snapshot);

    expect(countActiveDescendantRunsFromRuns(snapshot, root)).toBe(2);
    expect(countActiveDescendantRunsFromRuns(snapshot, root, "main")).toBe(1);
    mocks.readSnapshot = snapshot;
    expect(await mod.countPendingDescendantRuns(root, () => {})).toBe(4);
    expect(hasDescendantRunAwaitingSettleFromRuns(snapshot, root, pendingRun.runId)).toBe(true);
    expect(await mod.getLatestSubagentRunByChildSessionKey(reusedChild)).toBe(freshTerminal);
    expect(mod.buildSubagentSessionListReadIndex(now).getDisplaySubagentRun(reusedChild)).toBe(
      freshTerminal,
    );
    expect(mod.getLatestLiveSubagentRunByChildSessionKey(reusedChild)).toBe(freshTerminal);
    expect(mod.isSubagentSessionRunActive(parent)).toBe(false);
    expect(mod.listSubagentRunsForRequester(root)).toEqual([freshTerminal, parentRun]);
    expect(await mod.resolveRequesterForChildSession(reusedChild)).toEqual({
      requesterSessionKey: root,
      requesterOrigin: { channel: "discord", to: "room" },
    });
    expect(await mod.shouldIgnorePostCompletionAnnounceForSession(reusedChild)).toBe(true);
  });
});
