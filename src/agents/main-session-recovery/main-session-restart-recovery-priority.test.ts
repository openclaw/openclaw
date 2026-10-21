import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { admitAgentRestartRecovery } from "../../gateway/agent-turn/agent-run-recovery-admission.js";
import { registerChatAbortController } from "../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createContext as createGatewayTestContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getQueueSize,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createSubagentRunRecord, waitForFast } from "../subagent-test-fixtures.test-helpers.js";
import { reserveRestoredSubagentControllerSources } from "../subagents/announce/subagent-announce-controller-source.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { settleAcceptedRestartRecovery } from "./main-session-restart-dispatch-settlement.js";
import {
  createRestartRecoveryStoreFixture,
  mainSessionEntry,
} from "./main-session-restart-recovery-fixture.test-support.js";
import { makeUserMessage } from "./main-session-restart-recovery-transcript.test-support.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

let tmpDir: string;
let dispatchSettlement = createDeferred();
const callGateway = vi.fn(async () => ({ runId: "run-resumed" }));
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});
const { makeSessionsDir, writeStore, writeTranscript } = createRestartRecoveryStoreFixture(
  () => tmpDir,
);
beforeEach(async () => {
  callGateway.mockClear();
  dispatchSettlement = createDeferred();
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  resetCommandQueueStateForTest();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-priority-"));
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  resetGatewayWorkAdmission();
  resetCommandQueueStateForTest();
  await cleanupSessionStateForTest({ stateDir: tmpDir });
  await fs.rm(tmpDir, { recursive: true, force: true });
  clearRuntimeConfigSnapshot();
});

describe("demand-triggered restart recovery", () => {
  it("admits visible input recovery without waiting for unrelated background work", async ({
    signal,
  }) => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const cfg = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);
    const sessionKey = "agent:main:main";
    await writeStore(sessionsDir, { [sessionKey]: mainSessionEntry() });
    await writeTranscript(sessionsDir, "main-session", [
      makeUserMessage("finish the interrupted task"),
    ]);
    const backgroundStarted = createDeferred();
    const releaseBackground = createDeferred();
    const finishRecovery = createDeferred();
    const recoveryEntered = createDeferred();
    const background = enqueueCommandInLane("background", async () => {
      backgroundStarted.resolve();
      await releaseBackground.promise;
    });
    await backgroundStarted.promise;
    let dispatches = 0;
    let recoveryExecution: Promise<unknown> | undefined;
    const runtime: GatewayRecoveryRuntime = {
      ...mockRecoveryRuntime,
      dispatchAgent: <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        dispatches++;
        expect(request.lane).toBe("main");
        const sourceInput = options?.controllerInput;
        if (!sourceInput?.target) {
          throw new Error("Recovery dispatch omitted its controller input");
        }
        const registration = registerChatAbortController({
          runId: request.idempotencyKey,
          sessionKey,
          sessionId: "main-session",
          agentId: "main",
          target: sourceInput.target,
          sourceInput,
          timeoutMs: 60_000,
        });
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        let executionStarted = false;
        options?.onStartOwner?.({
          observe: () => ({ executionStarted, startDeadlineAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey });
        const execution = withSessionTurn(
          {
            sessionKey,
            sessionId: "main-session",
            target: sourceInput.target,
            controllerInput: sourceInput,
          },
          async () => {
            await admitAgentRestartRecovery({
              lifecycleGeneration,
              runId: request.idempotencyKey,
              sessionId: "main-session",
              sessionKey,
              storePath,
              activeRunAbort: registration,
            });
            return await enqueueCommandInLane(request.lane ?? "main", async () => {
              executionStarted = true;
              registration.markExecutionStarted();
              options?.onExecutionStarted?.();
              recoveryEntered.resolve();
              await finishRecovery.promise;
              await settleAcceptedRestartRecovery({
                agentId: "main",
                expectedRecoveryRunId: request.idempotencyKey,
                expectedSessionId: "main-session",
                lifecycleGeneration,
                sessionKey,
                sessionKeys: [sessionKey],
                storePath,
                terminalStatus: "ok",
              });
              return { runId: request.idempotencyKey, status: "ok" } as T;
            });
          },
        ).finally(() => registration.cleanup());
        recoveryExecution = execution;
        return execution;
      },
    };
    const context = createGatewayTestContext([], () => cfg);
    context.recoveryRuntime = runtime;
    const input = admitReplyTurn({
      agentId: "main",
      sessionKey,
      sessionId: "main-session",
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
      resolveGatewayContext: () => context,
      upstreamAbortSignal: signal,
    });
    let admitted: Awaited<typeof input> | undefined;
    try {
      await withinTest(recoveryEntered.promise, signal);
      expect(dispatches).toBe(1);
      expect(getQueueSize("background")).toBe(1);
      finishRecovery.resolve();
      admitted = await withinTest(input, signal);
      expect(admitted.status).toBe("owned");
      expect(dispatches).toBe(1);
      expect(loadSessionEntry({ storePath, sessionKey })?.abortedLastRun).toBe(false);
      expect(getQueueSize("background")).toBe(1);
    } finally {
      finishRecovery.resolve();
      releaseBackground.resolve();
      if (admitted?.status === "owned") {
        admitted.operation.complete();
      }
      const settled = await input.catch(() => undefined);
      if (settled?.status === "owned") {
        settled.operation.complete();
      }
      await Promise.all([background, recoveryExecution]);
    }
  });

  it("resumes an unmarked startup orphan before reserving its child completions", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:main";
    const cfg = { session: { store: storePath } };
    setRuntimeConfigSnapshot(cfg);
    await writeStore(sessionsDir, {
      [sessionKey]: mainSessionEntry({
        status: undefined,
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        lifecycleRunId: "interrupted-turn",
        restartRecoveryRuns: [{ runId: "interrupted-turn", lifecycleGeneration: "previous-boot" }],
      }),
    });
    await writeTranscript(sessionsDir, "main-session", [makeUserMessage("finish my task")]);
    const children = Array.from({ length: 8 }, (_, index) =>
      createSubagentRunRecord({
        runId: `child-${index}`,
        childSessionKey: `agent:main:subagent:child-${index}`,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: storePath,
        expectsCompletionMessage: true,
        createdAt: index + 1,
        execution: { status: "terminal", endedAt: index + 1, outcome: { status: "ok" } },
        delivery: { status: "pending", createdAt: index + 1 },
      }),
    );
    for (const child of children) {
      subagentRuns.set(child.runId, child);
    }
    const inputs = await reserveRestoredSubagentControllerSources(children);
    let execution: Promise<unknown> | undefined;
    const runtime: GatewayRecoveryRuntime = {
      ...mockRecoveryRuntime,
      dispatchAgent: <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        const input = options?.controllerInput;
        if (!input?.target) {
          throw new Error("Recovery dispatch omitted its controller input");
        }
        let executionStarted = false;
        options?.onStartOwner?.({
          observe: () => ({ executionStarted, startDeadlineAtMs: null }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey });
        execution = withSessionTurn(
          { sessionKey, sessionId: "main-session", target: input.target, controllerInput: input },
          async () => {
            executionStarted = true;
            options?.onExecutionStarted?.();
            await callGateway();
            await dispatchSettlement.promise;
            return { runId: request.idempotencyKey, status: "ok" };
          },
        );
        return execution as Promise<T>;
      },
    };
    try {
      // Startup may discover the store only when child restoration prepares it.
      // Those children must not hold raw FIFO positions ahead of the interrupted turn.
      expect(inputs).toHaveLength(0);
      expect(loadSessionEntry({ storePath, sessionKey })?.abortedLastRun).toBe(true);
      await expect(
        retryRestartAbortedMainSessionRecovery({
          agentId: "main",
          sessionKey,
          storePath,
          expectedSessionId: "main-session",
          gatewayRuntime: runtime,
        }),
      ).resolves.toMatchObject({ started: 1, failed: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
      const restored = await reserveRestoredSubagentControllerSources(children);
      inputs.push(...restored);
      expect(restored.map((input) => input.sourceTurnId)).toEqual(
        children.map((child) => `subagent-completion:${child.runId}:0`),
      );
    } finally {
      dispatchSettlement.resolve();
      for (const input of inputs) {
        retireSessionControllerInput(input);
      }
      for (const child of children) {
        subagentRuns.delete(child.runId);
      }
      await execution;
    }
  });

  it.each([false, true])(
    "respects main capacity before recovery ownership (replaced=%s)",
    async (replaced) => {
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      await writeStore(sessionsDir, { [sessionKey]: mainSessionEntry() });
      await writeTranscript(sessionsDir, "main-session", [
        makeUserMessage("finish interrupted work"),
      ]);
      setCommandLaneConcurrency("main", 1);
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = enqueueCommandInLane("main", async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const recovery = retryRestartAbortedMainSessionRecovery({
        agentId: "main",
        sessionKey,
        storePath,
        expectedSessionId: "main-session",
        lane: CommandLane.Main,
        gatewayRuntime: mockRecoveryRuntime,
      });
      try {
        await waitForFast(() => expect(getQueueSize("main")).toBe(2));
        expect(callGateway).not.toHaveBeenCalled();
        expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toMatchObject({
          chargedAttempts: 0,
        });
        expect(
          loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery?.reservation,
        ).toBeUndefined();
        if (replaced) {
          await replaceSessionEntry(
            { storePath, sessionKey },
            mainSessionEntry({ sessionId: "replacement-session" }),
          );
        }
        release.resolve();
        await expect(recovery).resolves.toMatchObject({ started: replaced ? 0 : 1 });
        expect(callGateway).toHaveBeenCalledTimes(replaced ? 0 : 1);
        expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe(
          replaced ? "replacement-session" : "main-session",
        );
      } finally {
        release.resolve();
        dispatchSettlement.resolve();
        await Promise.allSettled([blocker, recovery]);
      }
    },
  );
});
