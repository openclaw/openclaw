import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { admitAgentRestartRecovery } from "../../gateway/agent-turn/agent-run-recovery-admission.js";
import { registerChatAbortController } from "../../gateway/chat-abort.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createContext as createGatewayTestContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as agentEvents from "../../infra/agent-events.js";
import * as queue from "../../process/command-queue.js";
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
import * as fixtures from "./main-session-restart-recovery-fixture.test-support.js";
import { makeUserMessage } from "./main-session-restart-recovery-transcript.test-support.js";
import { retryRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

let tmpDir: string;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Dispatch = GatewayRecoveryRuntime["dispatchAgent"];
const session = { sessionKey: "agent:main:main", sessionId: "main-session" };
let dispatchSettlement = createDeferred();
const callGateway = vi.fn(async () => ({ runId: "run-resumed" }));
const mockRecoveryRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice: async () => ({ suppressed: false }),
});
const { makeMainSessionFixture, writeTranscript } = fixtures.createRestartRecoveryStoreFixture(
  () => tmpDir,
);
async function mainFixture(overrides: Parameters<typeof fixtures.mainSessionEntry>[0] = {}) {
  const fixture = await makeMainSessionFixture(overrides);
  const cfg = { session: { store: fixture.storePath } };
  await writeTranscript(fixture.sessionsDir, "main-session", [
    makeUserMessage("finish the interrupted task"),
  ]);
  const retry = (gatewayRuntime: GatewayRecoveryRuntime, lane?: CommandLane.Main) =>
    retryRestartAbortedMainSessionRecovery({
      agentId: "main",
      sessionKey: fixture.sessionKey,
      storePath: fixture.storePath,
      expectedSessionId: session.sessionId,
      gatewayRuntime,
      lane,
    });
  return { ...fixture, cfg, retry };
}
async function blockLane(lane: string) {
  const entered = createDeferred();
  const release = createDeferred();
  const task = queue.enqueueCommandInLane(lane, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { task, release };
}
beforeEach(() => {
  callGateway.mockClear();
  dispatchSettlement = createDeferred();
  agentEvents.resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  resetCommandQueueStateForTest();
  tmpDir = tempDirs.make("openclaw-recovery-priority-");
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  resetGatewayWorkAdmission();
  resetCommandQueueStateForTest();
  await cleanupSessionStateForTest({ stateDir: tmpDir });
  clearRuntimeConfigSnapshot();
});

it("admits visible input recovery without waiting for unrelated background work", async ({
  signal,
}) => {
  const { storePath, sessionKey, cfg, readEntry } = await mainFixture();
  setRuntimeConfigSnapshot(cfg);
  const { task: background, release: releaseBackground } = await blockLane("background");
  const finishRecovery = createDeferred();
  const recoveryEntered = createDeferred();
  let dispatches = 0;
  let recoveryExecution: Promise<unknown> | undefined;
  const runtime: GatewayRecoveryRuntime = {
    ...mockRecoveryRuntime,
    dispatchAgent: <T>(...[request, , options]: Parameters<Dispatch>) => {
      dispatches++;
      expect(request.lane).toBe("main");
      const sourceInput = options?.controllerInput;
      if (!sourceInput?.target) {
        throw new Error("Recovery dispatch omitted its controller input");
      }
      const registration = registerChatAbortController({
        runId: request.idempotencyKey,
        ...session,
        agentId: "main",
        target: sourceInput.target,
        sourceInput,
        timeoutMs: 60_000,
      });
      const lifecycleGeneration = agentEvents.getAgentEventLifecycleGeneration();
      let executionStarted = false;
      options?.onStartOwner?.({
        observe: () => ({ executionStarted, startDeadlineAtMs: Date.now() + 60_000 }),
        abort: () => false,
      });
      options?.onAccepted?.({ runId: request.idempotencyKey });
      const execution = withSessionTurn(
        {
          ...session,
          target: sourceInput.target,
          controllerInput: sourceInput,
        },
        async () => {
          await admitAgentRestartRecovery({
            lifecycleGeneration,
            runId: request.idempotencyKey,
            ...session,
            storePath,
            activeRunAbort: registration,
          });
          return await queue.enqueueCommandInLane(request.lane ?? "main", async () => {
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
    ...session,
    storePath,
    kind: "visible",
    resetTriggered: false,
    waitForActive: false,
    resolveGatewayContext: () => context,
    upstreamAbortSignal: signal,
  });
  try {
    await withinTest(recoveryEntered.promise, signal);
    expect(dispatches).toBe(1);
    expect(queue.getQueueSize("background")).toBe(1);
    finishRecovery.resolve();
    const admitted = await withinTest(input, signal);
    expect(admitted.status).toBe("owned");
    expect(dispatches).toBe(1);
    expect(readEntry()?.abortedLastRun).toBe(false);
    expect(queue.getQueueSize("background")).toBe(1);
  } finally {
    finishRecovery.resolve();
    releaseBackground.resolve();
    const settled = await input.catch(() => undefined);
    if (settled?.status === "owned") {
      settled.operation.complete();
    }
    await Promise.all([background, recoveryExecution]);
  }
});

it("resumes an unmarked startup orphan before reserving its child completions", async () => {
  const { storePath, sessionKey, cfg, readEntry, retry } = await mainFixture({
    status: undefined,
    abortedLastRun: false,
    mainRestartRecovery: undefined,
    lifecycleRunId: "interrupted-turn",
    restartRecoveryRuns: [{ runId: "interrupted-turn", lifecycleGeneration: "previous-boot" }],
  });
  setRuntimeConfigSnapshot(cfg);
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
    dispatchAgent: <T>(...[request, , options]: Parameters<Dispatch>) => {
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
        { ...session, target: input.target, controllerInput: input },
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
    expect(readEntry()?.abortedLastRun).toBe(true);
    await expect(retry(runtime)).resolves.toMatchObject({ started: 1, failed: 0 });
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
    const { storePath, sessionKey, readEntry, retry } = await mainFixture();
    queue.setCommandLaneConcurrency("main", 1);
    const { task: blocker, release } = await blockLane("main");
    const recovery = retry(mockRecoveryRuntime, CommandLane.Main);
    try {
      await waitForFast(() => expect(queue.getQueueSize("main")).toBe(2));
      expect(callGateway).not.toHaveBeenCalled();
      const pending = readEntry()?.mainRestartRecovery;
      expect({
        chargedAttempts: pending?.chargedAttempts,
        reservation: pending?.reservation,
      }).toEqual({ chargedAttempts: 0, reservation: undefined });
      if (replaced) {
        await replaceSessionEntry(
          { storePath, sessionKey },
          fixtures.mainSessionEntry({ sessionId: "replacement-session" }),
        );
      }
      release.resolve();
      await expect(recovery).resolves.toMatchObject({ started: replaced ? 0 : 1 });
      expect(callGateway).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(readEntry()?.sessionId).toBe(replaced ? "replacement-session" : "main-session");
    } finally {
      release.resolve();
      dispatchSettlement.resolve();
      await Promise.allSettled([blocker, recovery]);
    }
  },
);
