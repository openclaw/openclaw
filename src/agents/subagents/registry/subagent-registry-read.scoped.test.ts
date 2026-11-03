import { beforeEach, describe, expect, it, vi } from "vitest";
import { markAcpTurnActive } from "../../../acp/control-plane/active-turns.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { countUntrackedActiveAcpRunsForOwner } from "../spawn/acp-spawn-admission.js";
import { projectSubagentRunForSessionList } from "./subagent-delivery-state.js";
import {
  buildScopedSubagentRunReadIndexFromRuns,
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

function createRun(runId: string, overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "test task",
    cleanup: "keep",
    createdAt: 1,
    ...overrides,
    execution: overrides.execution ?? { status: "running" },
  };
}
const runMap = (...runs: SubagentRunRecord[]) => new Map(runs.map((run) => [run.runId, run]));
function publishLive(...runs: SubagentRunRecord[]) {
  for (const run of runs) {
    mocks.liveRuns.set(run.runId, run);
  }
}

it("keeps physical IDs, aliases, and requester/controller closures distinct through replacement", () => {
  const root = "agent:main:root";
  const controller = "agent:main:controller";
  const first = createRun("physical", {
    requesterSessionKey: root,
    controllerSessionKey: controller,
    swarmRunId: "slot",
  });
  const second = createRun("slot", {
    requesterSessionKey: first.childSessionKey,
    controllerSessionKey: root,
  });
  const lookup = new SubagentSessionReadLookup([
    ["slot", first],
    ["second-cache-key", second],
  ]);
  expect(lookup.selectRunIds(new Set(["slot"]))).toEqual(["slot", "second-cache-key"]);
  expect(lookup.selectRunIds(new Set(["physical"]))).toEqual(["slot"]);
  expect(lookup.selectControllers(new Set([root]))).toEqual(["second-cache-key"]);
  expect([...lookup.selectSessions([root], lookup).sessionKeys]).toEqual([
    root,
    first.childSessionKey,
    second.childSessionKey,
  ]);
  const moved = { ...first, requesterSessionKey: "agent:main:moved", controllerSessionKey: root };
  lookup.set("slot", moved);
  expect(lookup.selectControllers(new Set([controller]))).toEqual([]);
  expect(lookup.selectControllers(new Set([root]))).toEqual(["slot", "second-cache-key"]);
  expect(lookup.selectSessions([root], lookup).cacheKeys).toEqual([]);
  lookup.set("slot", undefined);
  expect(lookup.selectRunIds(new Set(["slot"]))).toEqual(["second-cache-key"]);
});

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

  it.each(["snapshot", "live"])(
    "uses the latest %s generation without full hydration",
    async (source) => {
      const childSessionKey = "agent:main:subagent:child";
      const older = createRun("older", { childSessionKey, generation: 1, createdAt: 200 });
      const latest = createRun("latest", { childSessionKey, generation: 2, createdAt: 100 });
      if (source === "live") {
        publishLive(older, latest);
      } else {
        mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(runMap(older, latest));
        mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(runMap(older, latest));
        expect(await mod.getLatestSubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
      }
      expect(
        mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey),
      ).toEqual(source === "live" ? projectSubagentRunForSessionList(latest) : latest);
      expect(mocks.getSubagentRunsSnapshotForChildSession).toHaveBeenCalledTimes(
        source === "live" ? 0 : 1,
      );
      expect(mocks.getSubagentRunsSnapshotForRead).not.toHaveBeenCalled();
    },
  );

  it.each([
    { storePath: null, ids: ["unknown"], excluded: "unknown" },
    { storePath: "store-a", ids: ["a"], excluded: "grandchild" },
  ])(
    "scopes requester root edges to $storePath while retaining child-agent descendants",
    ({ storePath, ids, excluded }) => {
      const root = "agent:main:root";
      const child = (runId: string, overrides: Partial<SubagentRunRecord> = {}) =>
        createRun(runId, {
          requesterSessionKey: root,
          requesterAgentId: "main",
          requesterStorePath: "store-a",
          ...overrides,
        });
      const parent = child("a", {
        childSessionKey: "agent:research:subagent:a",
        execution: { status: "terminal", endedAt: 100 },
        cleanupCompletedAt: 200,
      });
      const runs = [
        parent,
        child("b", { requesterStorePath: "store-b" }),
        child("unknown", { requesterStorePath: undefined }),
        child("grandchild", {
          requesterSessionKey: parent.childSessionKey,
          requesterAgentId: "research",
          requesterStorePath: "research-store",
        }),
        child("other-agent", { requesterAgentId: "other" }),
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
      ).toBe(1);
      expect(
        buildScopedSubagentRunReadIndexFromRuns(
          mocks.liveRuns,
          root,
          "main",
          storePath,
        ).hasDescendantRunAwaitingSettle(root, excluded),
      ).toBe(false);
    },
  );

  it("keeps an older live ACP child tracked despite newer terminal history", () => {
    const childSessionKey = "agent:main:acp:capacity-child";
    const ownerKey = "agent:main:subagent:capacity-owner";
    const older = createRun("capacity-active", {
      childSessionKey,
      requesterSessionKey: ownerKey,
      generation: 1,
      createdAt: Date.now() - 3 * 60 * 60_000,
    });
    const latest = createRun("capacity-terminal", {
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

  it("checks requester liveness without visiting unrelated retained runs", () => {
    const childSessionKey = "agent:main:subagent:requester";
    const older = createRun("requester-older", { childSessionKey, generation: 1 });
    const latest = createRun("requester-latest", {
      childSessionKey,
      generation: 2,
      execution: { status: "terminal", endedAt: 10 },
    });
    let unrelatedReads = 0;
    for (let index = 0; index < 32; index += 1) {
      const unrelated = createRun(`retained-${index}`, {
        execution: { status: "terminal", endedAt: 10 },
      });
      Object.defineProperty(unrelated, "childSessionKey", {
        get() {
          unrelatedReads += 1;
          return `agent:main:subagent:retained-${index}`;
        },
      });
      publishLive(unrelated);
    }
    publishLive(older, latest);
    mocks.getSubagentRunsForChildSession.mockReturnValue([older, latest]);
    const claim = claimAgentRunContext(
      older.runId,
      { sessionKey: childSessionKey },
      { trackOwner: true, ownsContext: true },
    );
    try {
      expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
      mocks.liveRuns.delete(latest.runId);
      mocks.getSubagentRunsForChildSession.mockReturnValue([older]);
      expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(true);
      releaseAgentRunContext(older.runId, claim);
      expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
      expect(unrelatedReads).toBe(0);
    } finally {
      releaseAgentRunContext(older.runId, claim);
    }
  });

  it("selects live controller roots while retaining legacy requester-owned runs", () => {
    const controllerSessionKey = "agent:main:controller";
    const explicit = createRun("explicit", {
      controllerSessionKey,
      requesterSessionKey: "agent:main:other",
    });
    const legacy = createRun("legacy", { requesterSessionKey: controllerSessionKey });
    const other = createRun("other", {
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
    const reusedChild = "agent:main:subagent:reused";
    const parent = "agent:main:subagent:parent";
    const row = (runId: string, overrides: Partial<SubagentRunRecord> = {}) =>
      createRun(runId, {
        requesterSessionKey: root,
        createdAt: now - 5_000,
        execution: { status: "running", startedAt: now - 4_900 },
        ...overrides,
      });
    const oldActive = row("run-reused-active", {
      childSessionKey: reusedChild,
      generation: 1,
    });
    const freshTerminal = row("run-reused-terminal", {
      childSessionKey: reusedChild,
      requesterOrigin: { channel: "discord", to: " room " },
      generation: 2,
      spawnMode: "run",
      cleanupCompletedAt: now - 1_000,
      execution: { status: "terminal", startedAt: now - 3_900, endedAt: now - 2_000 },
    });
    const parentRun = row("parent", {
      requesterAgentId: "main",
    });
    const foreignActive = row("foreign", {
      childSessionKey: "agent:research:subagent:foreign",
      requesterAgentId: "research",
    });
    const pendingRun = row("pending", {
      requesterSessionKey: parent,
      execution: { status: "terminal", startedAt: now - 1_900, endedAt: now - 1_500 },
    });
    const settledRun = row("settled", {
      requesterSessionKey: parent,
      cleanupCompletedAt: now - 1_200,
      execution: { status: "terminal", startedAt: now - 1_700, endedAt: now - 1_300 },
    });
    const suspendedRun = row("suspended", {
      requesterSessionKey: parent,
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
      [undefined, "main"].map((owner) =>
        buildScopedSubagentRunReadIndexFromRuns(snapshot, root, owner).countActiveDescendantRuns(
          root,
        ),
      ),
    ).toEqual([2, 1]);
    mocks.readSnapshot = snapshot;
    expect(await mod.countPendingDescendantRuns(root, () => {})).toBe(4);
    expect(
      buildScopedSubagentRunReadIndexFromRuns(snapshot, root).hasDescendantRunAwaitingSettle(
        root,
        pendingRun.runId,
      ),
    ).toBe(true);
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
