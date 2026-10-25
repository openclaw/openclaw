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
  getSubagentSessionListRunsSnapshotForSessions: () => new Map(),
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

describe("subagent registry scoped reads", () => {
  let mod: typeof import("./subagent-registry-read.js");

  beforeEach(async () => {
    mocks.liveRuns.clear();
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
      const latest = createRun("latest", {
        childSessionKey,
        generation: 2,
        createdAt: 100,
        requesterOrigin: { channel: "discord", to: " room " },
        execution: { status: "terminal", endedAt: 200 },
        cleanupCompletedAt: 300,
        spawnMode: "run",
      });
      if (source === "live") {
        publishLive(older, latest);
      } else {
        mocks.getSubagentRunsSnapshotForChildSession.mockResolvedValue(runMap(older, latest));
        mocks.getSubagentSessionListRunsSnapshotForRead.mockReturnValue(runMap(older, latest));
        expect(await mod.getLatestSubagentRunByChildSessionKey(childSessionKey)).toEqual(latest);
        expect(await mod.resolveRequesterForChildSession(childSessionKey)).toEqual({
          requesterSessionKey: latest.requesterSessionKey,
          requesterOrigin: { channel: "discord", to: "room" },
        });
        expect(await mod.shouldIgnorePostCompletionAnnounceForSession(childSessionKey)).toBe(true);
      }
      expect(
        mod.buildSubagentSessionListReadIndex().getDisplaySubagentRun(childSessionKey),
      ).toEqual(source === "live" ? projectSubagentRunForSessionList(latest) : latest);
      if (source === "live") {
        mocks.getSubagentRunsForChildSession.mockReturnValue([older, latest]);
        expect(mod.getLatestLiveSubagentRunByChildSessionKey(childSessionKey)).toBe(latest);
        expect(mod.isSubagentSessionRunActive(childSessionKey)).toBe(false);
        expect(mod.listSubagentRunsForRequester(latest.requesterSessionKey)).toEqual([
          older,
          latest,
        ]);
      }
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
      const index = buildScopedSubagentRunReadIndexFromRuns(
        mocks.liveRuns,
        root,
        "main",
        storePath,
      );
      expect(
        mod
          .listSubagentRunsForRequester(root, {
            requesterAgentId: "main",
            requesterStorePath: storePath,
          })
          .map((run) => run.runId),
      ).toEqual(ids);
      expect(index.countActiveDescendantRuns(root)).toBe(1);
      expect(index.hasDescendantRunAwaitingSettle(root, excluded)).toBe(false);
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
});
