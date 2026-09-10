import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { findTaskByRunId } from "../../../tasks/task-registry.js";
import { killSessionSubagentRuns } from "../registry/subagent-control-kill.js";
import { useSubagentControlFixture } from "../registry/subagent-control.test-support.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "../registry/subagent-registry-run-manager.js";
import { persistSubagentRunsToDiskOrThrow } from "../registry/subagent-registry-state.js";
import {
  adoptPausedSubagentRunForFollowUp,
  markRequesterTurnYielded,
  markSubagentRunTerminated,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../registry/subagent-registry.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { testing as registryTesting } from "../registry/subagent-registry.test-helpers.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryDeps,
} from "./subagent-announce-delivery.runtime.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";

const fixture = useSubagentControlFixture();
afterEach(() => setSubagentAnnounceDeliveryDepsForTest());

it.each([
  "pending",
  "admitted",
  "unsuppressed",
  "failed kill",
  "requester reset",
  "requester replacement",
] as const)(
  "settles a yielded requester's child after %s cancellation without reviving cancelled work",
  async (phase) => {
    const owner = "agent:main:main";
    const requesterKey = "agent:main:subagent:yielded-requester";
    const nestedKey = "agent:main:subagent:required-child";
    let storePath = "";
    for (const [runId, sessionKey, requesterSessionKey] of [
      ["requester", requesterKey, owner],
      ["nested", nestedKey, requesterKey],
    ] as const) {
      storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: `${runId}-session`,
      });
      registerSubagentRun({
        runId,
        childSessionKey: sessionKey,
        requesterSessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: runId === "nested" ? "requester" : undefined,
        requesterDisplayKey: requesterSessionKey,
        task: runId,
        cleanup: "keep",
        expectsCompletionMessage: runId === "nested",
      });
    }
    expect(
      markRequesterTurnYielded({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
      }),
    ).toBe(1);
    expect(markSubagentRunPausedAfterYield({ entry: subagentRuns.get("requester")! })).toBe(true);
    persistSubagentRunsToDiskOrThrow(subagentRuns, ["requester"]);
    expect(
      settleRequesterAfterSessionSpawns({
        requesterSessionKey: requesterKey,
        requesterAgentId: "main",
        requesterTurnRunId: "requester",
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "nested", childSessionKey: nestedKey, expectsCompletionMessage: true },
        ],
      }),
    ).toBe(true);

    const admitted = createDeferredCore();
    const execute = createDeferredCore();
    const startedTurns: string[] = [];
    const waitBeforeExecution =
      phase === "admitted" || phase === "requester reset" || phase === "requester replacement";
    type Dispatch = SubagentAnnounceDeliveryDeps["dispatchGatewayMethodInProcess"];
    const completion = { dispatch: dispatchGatewayMethodInProcess };
    vi.spyOn(completion, "dispatch").mockResolvedValue({
      status: "ok",
      result: { payloads: [{ text: "The child has settled." }], meta: {} },
    });
    const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
      const [, params, options] = args;
      // Production admission adopts a paused requester before execution starts.
      adoptPausedSubagentRunForFollowUp({
        childSessionKey: String(params?.sessionKey),
        runId: String(params?.idempotencyKey),
        task: String(params?.message),
      });
      admitted.resolve();
      if (waitBeforeExecution) {
        await execute.promise;
      }
      options?.onExecutionStarted?.();
      startedTurns.push(String(params?.sessionKey));
      return await completion.dispatch<T>(...args);
    };
    setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });

    if (phase !== "pending") {
      // A terminal child is skipped by tree cancellation; its yielded requester
      // still owns the pending synthesis and must fence an already admitted wake.
      expect(markSubagentRunTerminated({ runId: "nested", reason: "killed" })).toBe(1);
    }
    if (waitBeforeExecution) {
      await registryTesting.sweepOnceForTests();
      await admitted.promise;
    }
    if (phase === "failed kill") {
      fixture.persist.mockImplementation((runs, changedRunIds) => {
        if (runs.get("requester")?.killIntent) {
          throw new Error("requester kill intent rejected");
        }
        persistSubagentRunsToDiskOrThrow(runs, changedRunIds);
      });
    }
    if (phase === "requester reset") {
      await patchSessionEntryCore({ storePath, sessionKey: requesterKey }, (entry) => ({
        ...entry,
        lifecycleRevision: "replacement-incarnation",
      }));
    }
    if (phase === "requester replacement") {
      registerSubagentRun({
        runId: "replacement",
        childSessionKey: requesterKey,
        requesterSessionKey: owner,
        requesterAgentId: "main",
        requesterDisplayKey: owner,
        task: "unrelated replacement",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
    }
    try {
      if (phase === "pending" || phase === "admitted" || phase === "failed kill") {
        const result = await killSessionSubagentRuns({
          cfg: getRuntimeConfig(),
          sessionKey: owner,
          agentId: "main",
        });
        expect(result.status).toBe(phase === "failed kill" ? "error" : "ok");
      }
      execute.resolve();
      if (!waitBeforeExecution) {
        await registryTesting.sweepOnceForTests();
      }
      await settleSubagentRegistryPersistenceWork();
      if (phase === "unsuppressed" || phase === "failed kill") {
        expect(startedTurns).toEqual([requesterKey]);
      } else {
        expect(startedTurns).toEqual([]);
        if (phase === "pending" || phase === "admitted") {
          expect(findTaskByRunId("requester")?.status).toBe("cancelled");
          expect(findTaskByRunId("nested")?.status).toBe("cancelled");
        }
      }
      expect(subagentRuns.get("nested")?.requesterSettleWake).toBeUndefined();
    } finally {
      execute.resolve();
      await settleSubagentRegistryPersistenceWork();
    }
  },
);
