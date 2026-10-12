/**
 * ACP spawn child-capacity cases: depth ceiling, per-session child cap
 * accounting for in-flight dispatches, independent ACP turns, and capacity
 * return when registration fails.
 *
 * Extracted from acp-spawn.test.ts so that file stays under its line cap;
 * these cases share the same spawn fixture through the register hook the
 * sibling policy/owner suites already use.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import type { spawnAcpDirect } from "./acp-spawn.js";

type SpawnRequest = Parameters<typeof spawnAcpDirect>[0];
type SpawnContext = Parameters<typeof spawnAcpDirect>[1];
type SpawnResult = Awaited<ReturnType<typeof spawnAcpDirect>>;

type CapacityFixture = {
  spawn: (request?: Partial<SpawnRequest>, context?: SpawnContext) => Promise<SpawnResult>;
  requesterContext: SpawnContext;
  configureSubagentDefaults: (
    subagents: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["subagents"],
  ) => void;
  trackActiveAcpTurn: (sessionKey: string, ownerSessionKey: string) => void;
  expectAcceptedSpawn: (result: SpawnResult) => Extract<SpawnResult, { status: "accepted" }>;
  expectFailedSpawn: (
    result: SpawnResult,
    status?: "error" | "forbidden",
  ) => Extract<SpawnResult, { status: "error" | "forbidden" }>;
  mocks: {
    callGateway: Mock;
    cleanupFailedAcpSpawn: Mock;
    countActiveRunsForSession: Mock;
    getSubagentRun: Mock;
    registerSubagentRun: Mock;
  };
};

export function registerAcpSpawnCapacityTests({
  spawn,
  requesterContext,
  configureSubagentDefaults,
  trackActiveAcpTurn,
  expectAcceptedSpawn,
  expectFailedSpawn,
  mocks,
}: CapacityFixture) {
  it("rejects ACP spawns that exceed subagent max depth", async () => {
    const result = await spawn(
      { mode: "run" },
      {
        ...requesterContext,
        agentSessionKey: "agent:main:subagent:parent:subagent:leaf",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("current depth: 2, max: 2");
  });

  it.each([1, 2])("counts a pending dispatch exactly once against cap %s", async (cap) => {
    configureSubagentDefaults({ maxChildrenPerAgent: cap });
    mocks.countActiveRunsForSession.mockImplementation(
      () => mocks.registerSubagentRun.mock.calls.length,
    );
    if (cap === 2) {
      mocks.getSubagentRun.mockImplementation((childSessionKey: string) =>
        mocks.registerSubagentRun.mock.calls.some(
          ([run]) => run.childSessionKey === childSessionKey,
        )
          ? { childSessionKey, execution: { status: "running" } }
          : null,
      );
    }
    const entered = createDeferred();
    const release = createDeferred();
    const context = {
      ...requesterContext,
      agentSessionKey: "agent:main:subagent:parent",
      ...(cap === 1 ? { completionOwnerKey: "agent:main:main" } : {}),
    };
    let dispatchedRuns = 0;
    mocks.callGateway.mockImplementation(
      async (request: { method?: string; params?: { sessionKey?: string } }) => {
        if (request.method !== "agent") {
          return {};
        }
        const runNumber = ++dispatchedRuns;
        if (cap === 2) {
          trackActiveAcpTurn(
            expectDefined(request.params?.sessionKey, "dispatched child"),
            context.agentSessionKey,
          );
        }
        if (runNumber === 1) {
          entered.resolve();
          await release.promise;
        }
        return { runId: `acp-run-${runNumber}` };
      },
    );
    const first = spawn({ mode: "run" }, context);
    try {
      await entered.promise;
      const second = await spawn({ mode: "run" }, context);
      if (cap === 1) {
        expect(expectFailedSpawn(second, "forbidden")).toMatchObject({
          errorCode: "subagent_policy",
          error: expect.stringContaining("max active children for this session (1/1"),
        });
      } else {
        expectAcceptedSpawn(second);
      }
    } finally {
      release.resolve();
    }
    expectAcceptedSpawn(await first);
    expect(dispatchedRuns).toBe(cap);
    expect(mocks.registerSubagentRun).toHaveBeenCalledTimes(cap);
  });

  it("counts unrelated active ACP turns separately from anonymous child reservations", async () => {
    configureSubagentDefaults({ maxChildrenPerAgent: 2 });
    trackActiveAcpTurn("agent:codex:acp:independent-task", "agent:main:subagent:parent");
    const controllerSessionKey = "agent:main:subagent:parent";
    const pendingNativeChild = reserveChildAdmissionSlot({
      controllerSessionKey,
      resolveAdmission: () => ({ ok: true as const }),
    });
    if (!pendingNativeChild.ok) {
      throw new Error("Expected native child reservation");
    }

    try {
      const rejected = await spawn(
        { mode: "run" },
        {
          ...requesterContext,
          agentSessionKey: controllerSessionKey,
        },
      );

      expect(expectFailedSpawn(rejected, "forbidden")).toMatchObject({
        errorCode: "subagent_policy",
        error: expect.stringContaining("max active children for this session (2/2"),
      });
      expect(mocks.callGateway).not.toHaveBeenCalled();
    } finally {
      pendingNativeChild.release();
    }
  });

  it("returns ACP child capacity after run registration fails", async () => {
    configureSubagentDefaults({ maxChildrenPerAgent: 1 });
    mocks.registerSubagentRun.mockRejectedValueOnce(new Error("registry unavailable"));
    const context = {
      ...requesterContext,
      agentSessionKey: "agent:main:subagent:parent",
    };

    const failed = await spawn({ mode: "run" }, context);
    const replacement = await spawn({ mode: "run" }, context);

    expect(expectFailedSpawn(failed, "error")).toMatchObject({
      errorCode: "spawn_failed",
      error: expect.stringContaining("registry unavailable"),
    });
    expect(failed).toHaveProperty("runId", "run-1");
    expect(mocks.cleanupFailedAcpSpawn).toHaveBeenCalledTimes(1);
    expectAcceptedSpawn(replacement);
    expect(mocks.registerSubagentRun).toHaveBeenCalledTimes(2);
  });
}
