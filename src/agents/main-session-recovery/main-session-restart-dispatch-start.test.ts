import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { AgentTurnIo } from "../../gateway/agent-turn/types.js";
import { registerChatAbortController } from "../../gateway/chat-abort.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createEmbeddedRunLaneController } from "../embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../embedded-agent-runner/run/params.js";
import {
  dispatchRestartRecoveryUntilStarted as dispatchRecovery,
  normalizeRestartRecoveryTerminalStatus,
} from "./main-session-restart-dispatch-start.js";

const sessionKey = "agent:main:recovery-capacity";
const sessionId = "recovery-session";
const runId = "recovery-run";
const identity = { agentId: "main", sessionKey, sessionId, runId } as const;
const globalLane = "recovery-capacity-global";
const startTurn = vi.hoisted(() => vi.fn<(params: { io: AgentTurnIo }) => Promise<void>>());

vi.mock("../../gateway/server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
vi.mock("../../gateway/server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));
vi.mock("../../gateway/agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
vi.mock("../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

const fixture = useTempSessionsFixture("recovery-start-owner-");

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  startTurn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.useRealTimers();
});

it.each([
  {
    name: "restart cancellation remains owed",
    result: { status: "error", stopReason: "restart", timeoutPhase: "queue" },
    expected: undefined,
  },
  {
    name: "an attributed timeout takes precedence over restart metadata",
    result: { status: "timeout", stopReason: "restart", timeoutPhase: "provider" },
    expected: "timeout",
  },
  {
    name: "explicit Stop remains cancellation in a legacy timeout response",
    result: { status: "timeout", stopReason: "rpc", timeoutPhase: "queue" },
    expected: "cancelled",
  },
])("preserves terminal facts when $name", ({ result, expected }) => {
  expect(normalizeRestartRecoveryTerminalStatus(result)).toBe(expected);
});

it.each([
  "session queue",
  "global queue",
  "cached queue",
  "runtime preparation",
  "expired startup",
] as const)("uses the registered startup owner during %s", async (stage) => {
  const cached = stage === "cached queue";
  const expired = stage === "expired startup";
  const context = createDirectChatContext({ trackExecution: trackAsyncWork });
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => createGatewayMethodRegistry([]),
    isDispatchAvailable: () => true,
  });
  const preparation = createDeferred();
  const registered = createDeferred();
  const finish = createDeferred();
  const executionEntered = createDeferred();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const timeoutMs = 60_000;
  const target = captureSessionTarget({
    storeScope: fixture.storePath(),
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const predecessor =
    stage === "session queue"
      ? createReplyOperation({ sessionKey, sessionId, resetTriggered: false, target })
      : undefined;
  const registration = registerChatAbortController({
    target,
    runId,
    agentId: "main",
    sessionId,
    sessionKey,
    lifecycleGeneration,
    kind: "agent",
    timeoutMs,
  });
  registration.initializeTiming();
  registerAgentRunContext(runId, { sessionKey, sessionId, lifecycleGeneration });
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    ...identity,
    sessionTarget: { agentId: "main", sessionKey, sessionId, storePath: target.storeScope },
    sessionFile: sessionKey,
    lifecycleGeneration,
    abortSignal: registration.controller.signal,
    prompt: "continue after restart",
    timeoutMs,
    trigger: "user",
    inputProvenance: {
      kind: "internal_system",
      sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
    },
    workspaceDir: "/tmp",
  };
  const lanes = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    setLifecycleGeneration: () => {},
    setParams: (next) => {
      params = next;
    },
  });
  const blockedLane = stage === "global queue" || cached ? globalLane : undefined;
  if (blockedLane) {
    setCommandLaneConcurrency(blockedLane, 0);
  }
  const startupDeadlineAtMs = Date.now() + timeoutMs;
  let execution: Promise<void> | undefined;
  startTurn.mockImplementation(({ io }) => {
    execution = (async () => {
      assert(registration.registered, "expected a registered recovery owner");
      if (!cached) {
        io.emitStartOwner?.(runId, registration.entry);
      }
      registered.resolve();
      io.emitAcceptance([true, { runId, status: cached ? "in_flight" : "accepted" }, undefined], {
        runId,
        ...(cached ? { cached: true } : {}),
      });
      await withSessionTurn(
        {
          sessionKey,
          sessionId,
          target,
          controllerInput: registration.entry.input,
          abortSignal: registration.controller.signal,
        },
        async (operation) => {
          assert(operation, "expected admitted recovery operation");
          params = { ...params, replyOperation: operation };
          const startup = operation.watchdog.beginExecution(() => startupDeadlineAtMs);
          try {
            if (stage === "runtime preparation" || expired) {
              await preparation.promise;
              operation.abortSignal.throwIfAborted();
            }
            await lanes.enqueueSession(() =>
              lanes.enqueueGlobal(async () => {
                expect(registration.markExecutionStarted()).toBe(true);
                executionEntered.resolve();
                if (!cached) {
                  io.emitExecutionStarted?.();
                }
                await finish.promise;
                return { meta: { durationMs: 0 } };
              }),
            );
          } finally {
            startup.close();
          }
        },
      );
      io.emitFinal([true, { runId, status: "ok" }, undefined], { runId });
    })();
    return execution;
  });
  const onSettled = vi.fn();
  const recovery = dispatchRecovery({
    agentParams: {
      agentId: "main",
      expectedExistingSessionId: sessionId,
      idempotencyKey: runId,
      message: "continue after restart",
      sessionKey,
    },
    gatewayRuntime: runtime.recovery,
    onSettled,
  });
  try {
    await registered.promise;
    await vi.advanceTimersByTimeAsync(0);
    if (blockedLane) {
      expect(getCommandLaneSnapshot(blockedLane).queuedCount).toBe(1);
    }
    if (expired) {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(registration.entry?.input.claim?.operation?.abortSignal.aborted).toBe(true);
      expect(registration.entry?.input.claim?.released).toBe(false);
      await expect(recovery).resolves.toMatchObject({
        kind: "failed",
        observation: { executionStarted: false },
      });
      return;
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(registration.controller.signal.aborted).toBe(false);
    preparation.resolve();
    predecessor?.complete();
    if (blockedLane) {
      setCommandLaneConcurrency(blockedLane, 1);
    }
    assert(execution, "expected recovery execution to be registered");
    await awaitGateBeforeSettlement(
      executionEntered.promise,
      execution,
      "recovery execution settled before entering its task",
    );
    if (cached) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(onSettled).not.toHaveBeenCalled();
    await expect(recovery).resolves.toMatchObject({
      kind: "started",
      observation: { dispatchAccepted: true, executionStarted: true },
    });
  } finally {
    predecessor?.complete();
    preparation.resolve();
    finish.resolve();
    if (blockedLane) {
      setCommandLaneConcurrency(blockedLane, 1);
    }
    await execution?.catch(() => {});
    await recovery;
    await vi.advanceTimersByTimeAsync(0);
    if (!cached && !expired) {
      expect(onSettled).toHaveBeenCalledOnce();
    }
    registration.cleanup();
    runtime.close();
  }
});
