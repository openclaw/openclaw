// Proves opted-in CLI-backend dispatch executes inside embedded lane
// admission: the dispatch decision and the CLI run must happen within the
// enqueued global-lane task, not before it, so dispatched runs obey the same
// lifecycle, placement, and concurrency gates as native embedded runs.
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  buildTurnSendLedgerSessionKey,
  clearTurnSendLedgerForRun,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
  type TurnSendLedgerScope,
} from "../tools/turn-send-ledger.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const runEmbeddedAgentViaCliBackendIfEligible = vi.hoisted(() => vi.fn());
vi.mock("./cli-backend-dispatch.js", () => ({
  runEmbeddedAgentViaCliBackendIfEligible,
}));

import { runEmbeddedAgent } from "./run.js";

const tempRoot = useSessionStoreTempDirs(afterAll, "cli-dispatch-lane-").make();

const dispatchResult: EmbeddedAgentRunResult = {
  payloads: [{ text: "dispatched" }],
  meta: {
    durationMs: 1,
    agentMeta: { usage: {} },
  },
} as unknown as EmbeddedAgentRunResult;

function laneRunParams() {
  return {
    admittedRunContext: createTestAdmittedRunContext("run-cli-dispatch-lane-test"),
    sessionId: "recall-lane-session",
    sessionKey: "agent:main:recall-lane-test",
    agentId: "main",
    sessionTarget: {
      agentId: "main",
      sessionId: "recall-lane-session",
      sessionKey: "agent:main:recall-lane-test",
      storePath: join(tempRoot, "sessions.json"),
    },
    sessionFile: join(tempRoot, "session.jsonl"),
    workspaceDir: join(tempRoot, "workspace"),
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    timeoutMs: 5_000,
    runId: "run-cli-dispatch-lane-test",
    config: {},
    cliBackendDispatch: "subscription-auth" as const,
  };
}

describe("runEmbeddedAgent CLI dispatch lane admission", () => {
  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
  });

  it("resolves and executes CLI dispatch inside the global-lane task", async () => {
    const order: string[] = [];
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(async () => {
      order.push("dispatch-run");
      return dispatchResult;
    });
    // The custom enqueue hook stands in for both the session and the global
    // lane, so a compliant run enters it twice before dispatching.
    const enqueue: CommandQueueEnqueueFn = async (task) => {
      order.push("global-lane-enter");
      const result = await task();
      order.push("global-lane-exit");
      return result;
    };

    const params = laneRunParams();
    setRuntimeConfigSnapshot(params.config);
    onTestFinished(clearRuntimeConfigSnapshot);
    const sessionEntry: InternalSessionEntry = {
      sessionId: params.sessionId,
      updatedAt: 1,
      lifecycleRevision: "cli-dispatch-lifecycle",
    };
    await upsertSessionEntryCore(params.sessionTarget, sessionEntry);
    const result = await runEmbeddedAgent({ ...params, enqueue });

    expect(result.payloads?.[0]?.text).toBe("dispatched");
    // Both lane admissions (session, then global) must fully wrap the
    // dispatch decision and execution.
    expect(order).toEqual([
      "global-lane-enter",
      "global-lane-enter",
      "dispatch-run",
      "global-lane-exit",
      "global-lane-exit",
    ]);
    expect(runEmbeddedAgentViaCliBackendIfEligible).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentViaCliBackendIfEligible.mock.calls[0]?.[0].sessionTarget).toMatchObject({
      ...params.sessionTarget,
      expectedWriterRunId: params.runId,
      expectedLifecycleRevision: sessionEntry.lifecycleRevision,
    });
  });
});

describe("runEmbeddedAgent CLI dispatch per-turn send ledger ownership", () => {
  const targetKey = "imessage default +15550001111";
  // A loopback grant may canonicalize and agent-shift the slot identity, so the dispatched
  // candidate reports this prepared scope rather than letting the owner rebuild it.
  const grantScope = (runId: string): TurnSendLedgerScope => ({
    agentId: "reef",
    sessionKey: "agent:reef:main",
    runId,
  });

  function slotKey(scope: TurnSendLedgerScope) {
    return {
      sessionKey: buildTurnSendLedgerSessionKey(scope.agentId, scope.sessionKey)!,
      runId: scope.runId,
      targetKey,
    };
  }

  // Stands in for the dispatched CLI run: a loopback send commits under the grant scope and
  // CLI settlement reports that scope to the run's owner callback.
  function mockDispatchedSend(outcome: "success" | "error") {
    runEmbeddedAgentViaCliBackendIfEligible.mockImplementation(
      async (params: {
        runId: string;
        onDeferredTurnSendLedgerScope?: (scope: TurnSendLedgerScope) => void;
      }) => {
        const scope = grantScope(params.runId);
        const reserved = reserveTurnSend(slotKey(scope), {});
        if (reserved.status !== "reserved") {
          throw new Error(`expected a reserved send, got "${reserved.status}"`);
        }
        commitTurnSend(reserved.reservation);
        params.onDeferredTurnSendLedgerScope?.(scope);
        if (outcome === "error") {
          throw new Error("dispatched cli run failed");
        }
        return dispatchResult;
      },
    );
  }

  async function seedSession(params: ReturnType<typeof laneRunParams>) {
    await upsertSessionEntryCore(params.sessionTarget, {
      sessionId: params.sessionId,
      updatedAt: 1,
      lifecycleRevision: "cli-dispatch-lifecycle",
    });
  }

  beforeEach(() => {
    runEmbeddedAgentViaCliBackendIfEligible.mockReset();
    resetTurnSendLedgerForTest();
  });

  it("clears the dispatched candidate's exact scope when no owner encloses the run", async () => {
    mockDispatchedSend("success");
    const params = laneRunParams();
    await seedSession(params);

    await runEmbeddedAgent(params);

    expect(peekTurnSendCount(slotKey(grantScope(params.runId)))).toBe(0);
  });

  it("clears the dispatched candidate's exact scope when an ownerless run fails", async () => {
    mockDispatchedSend("error");
    const params = laneRunParams();
    await seedSession(params);

    await expect(runEmbeddedAgent(params)).rejects.toThrow("dispatched cli run failed");

    expect(peekTurnSendCount(slotKey(grantScope(params.runId)))).toBe(0);
  });

  it("hands the dispatched scope to an enclosing owner without clearing it", async () => {
    mockDispatchedSend("success");
    const params = laneRunParams();
    await seedSession(params);
    const reported: TurnSendLedgerScope[] = [];

    await runEmbeddedAgent({
      ...params,
      onDeferredTurnSendLedgerScope: (scope) => reported.push(scope),
    });

    expect(peekTurnSendCount(slotKey(grantScope(params.runId)))).toBe(1);
    expect(reported).toEqual([grantScope(params.runId)]);
    clearTurnSendLedgerForRun(reported[0]!);
    expect(peekTurnSendCount(slotKey(grantScope(params.runId)))).toBe(0);
  });
});
