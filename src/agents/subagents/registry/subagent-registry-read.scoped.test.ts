import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAcpTurnActive } from "../../../acp/control-plane/active-turns.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { countUntrackedActiveAcpRunsForOwner } from "../spawn/acp-spawn-admission.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  buildScopedSubagentRunReadIndexFromRuns,
  hasDescendantRunAwaitingSettleFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { SubagentSessionReadLookup } from "./subagent-session-read-scope.js";

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

// mock-isolation: Scoped reads use fixture rows without initializing the live registry owner.
vi.mock("./subagent-registry-memory.js", () => ({
  getSubagentRunsForChildSession: mocks.getSubagentRunsForChildSession,
  getSubagentSessionReadLookup: (runs: ReadonlyMap<string, SubagentRunRecord>) =>
    new SubagentSessionReadLookup(runs),
  immutableSubagentRunSessionList: (entry: SubagentRunRecord) =>
    projectSubagentRunForSessionList(entry),
  subagentRuns: mocks.liveRuns,
}));

// mock-isolation: Scoped reads consume fixture snapshots without opening the shared-state worker.
vi.mock("./subagent-registry-state.js", () => ({
  getSubagentSessionListRunsSnapshotForRead: mocks.getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForChildSessions:
    mocks.getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  prepareSubagentSessionListReadCache: async () => {},
  getSubagentSessionListRunsSnapshotForSessions: () => mocks.readSnapshot,
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
const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));
function publishLive(...runs: SubagentRunRecord[]) {
  for (const run of runs) {
    mocks.liveRuns.set(run.runId, run);
  }
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
    mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(runMap(older, latest));
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(runMap(older, latest));

    expect(await mod.getLatestSubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
    expect(mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey)).toEqual(
      latest,
    );
    expect(mocks.getSubagentRunsSnapshotForChildSession).toHaveBeenCalledOnce();
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it.each([
    { storePath: null, ids: ["unknown"], active: 1, excluded: "unknown", waiting: false },
    { storePath: "store-a", ids: ["a"], active: 1, excluded: "grandchild", waiting: false },
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
      publishLive(...runs);
      expect(
        mod
          .listSubagentRunsForRequester(root, {
            requesterAgentId: "main",
            requesterStorePath: storePath,
          })
          .map((run) => run.runId),
      ).toEqual(ids);
      expect(
        buildScopedSubagentRunReadIndexFromRuns(
          mocks.liveRuns,
          root,
          "main",
          storePath,
        ).countActiveDescendantRuns(root),
      ).toBe(active);
      expect(
        hasDescendantRunAwaitingSettleFromRuns(mocks.liveRuns, root, excluded, "main", storePath),
      ).toBe(waiting);
    },
  );

  it("keeps the latest live generation authoritative without retaining its payload in display", () => {
    const childSessionKey = "agent:main:subagent:child";
    const older = createRun({ runId: "older", childSessionKey, generation: 1, createdAt: 200 });
    const latest = createRun({ runId: "latest", childSessionKey, generation: 2, createdAt: 100 });
    publishLive(older, latest);

    expect(mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey)).toEqual(
      projectSubagentRunForSessionList(latest),
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
    publishLive(older, latest);
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
    publishLive(explicit, legacy, other);
    expect(listRunsForControllerFromRuns(mocks.liveRuns, controllerSessionKey)).toEqual([
      explicit,
      legacy,
    ]);
    expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
  });

  it("keeps every bound read equivalent to its documented snapshot scope", async () => {
    const now = Date.now();
    const root = "agent:main:root";
    const controller = "agent:main:controller";
    const reusedChild = "agent:main:subagent:reused";
    const parent = "agent:main:subagent:parent";
    const row = (
      runId: string,
      childSessionKey: string,
      requesterSessionKey: string,
      createdAgo: number,
      overrides: Partial<SubagentRunRecord> = {},
    ) =>
      createRun({
        runId,
        childSessionKey,
        requesterSessionKey,
        createdAt: now - createdAgo,
        execution: { status: "running", startedAt: now - createdAgo + 100 },
        ...overrides,
      });
    const oldActive = row("run-reused-active", reusedChild, root, 5_000, {
      controllerSessionKey: controller,
      generation: 1,
    });
    const freshTerminal = row("run-reused-terminal", reusedChild, root, 4_000, {
      requesterOrigin: { channel: "discord", to: " room " },
      controllerSessionKey: controller,
      generation: 2,
      spawnMode: "run",
      cleanupCompletedAt: now - 1_000,
      execution: { status: "terminal", startedAt: now - 3_900, endedAt: now - 2_000 },
    });
    const parentRun = row("run-parent", parent, root, 3_000, {
      requesterAgentId: "main",
      controllerSessionKey: controller,
    });
    const foreignActive = row(
      "run-foreign-active",
      "agent:research:subagent:foreign",
      root,
      2_500,
      {
        requesterAgentId: "research",
      },
    );
    const pendingRun = row("run-pending", "agent:main:subagent:pending", parent, 2_000, {
      execution: { status: "terminal", startedAt: now - 1_900, endedAt: now - 1_500 },
    });
    const settledRun = row("run-settled", "agent:main:subagent:settled", parent, 1_800, {
      cleanupCompletedAt: now - 1_200,
      execution: { status: "terminal", startedAt: now - 1_700, endedAt: now - 1_300 },
    });
    const suspendedRun = row("run-suspended", "agent:main:subagent:suspended", parent, 1_600, {
      delivery: { status: "suspended", disposition: "permanent_failure" },
      execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_100 },
    });
    const snapshot = runMap(
      oldActive,
      freshTerminal,
      parentRun,
      foreignActive,
      pendingRun,
      settledRun,
      suspendedRun,
    );
    const childSnapshot = runMap(oldActive, freshTerminal);
    publishLive(freshTerminal, parentRun);
    mocks.getSubagentRunsForChildSession.mockImplementation((childSessionKey) =>
      [...mocks.liveRuns.values()].filter((run) => run.childSessionKey === childSessionKey),
    );
    mocks.getSubagentRunsSnapshotForRead.mockReturnValue(snapshot);
    mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(childSnapshot);
    mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(snapshot);

    expect(
      buildScopedSubagentRunReadIndexFromRuns(snapshot, root).countActiveDescendantRuns(root),
    ).toBe(2);
    expect(
      buildScopedSubagentRunReadIndexFromRuns(snapshot, root, "main").countActiveDescendantRuns(
        root,
      ),
    ).toBe(1);
    mocks.readSnapshot = snapshot;
    expect(await mod.countPendingDescendantRuns(root, () => {})).toBe(4);
    expect(hasDescendantRunAwaitingSettleFromRuns(snapshot, root, pendingRun.runId)).toBe(true);
    expect(await mod.getLatestSubagentRunByChildSessionKey(reusedChild)).toBe(freshTerminal);
    expect(mod.buildSubagentSessionListReadIndex(now).getDisplaySubagentRun(reusedChild)).toEqual(
      projectSubagentRunForSessionList(freshTerminal),
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
