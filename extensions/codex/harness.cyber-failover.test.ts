import { vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  TURN_ID,
} from "./src/app-server/event-projector.test-harness.js";
import type { runCodexAppServerAttempt } from "./src/app-server/run-attempt.js";

const runAttempt = vi.hoisted(() => vi.fn<typeof runCodexAppServerAttempt>());
vi.mock("./src/app-server/run-attempt.js", () => ({ runCodexAppServerAttempt: runAttempt }));

import { createCodexAppServerAgentHarness } from "./harness.js";
import { attemptTerminal } from "./src/app-server/attempt-terminal.js";
import { testCodexAppServerBindingStore } from "./src/app-server/session-binding.test-helpers.js";

registerCodexEventProjectorTestLifecycle();

const PRIMARY = "gpt-5.6-sol";
const FALLBACK = "gpt-5.6-terra";

type AttemptParams = Awaited<ReturnType<typeof createParams>>;

async function paramsForWorkspace(agentId: string, sessionId: string) {
  const params = await createParams();
  return {
    ...params,
    agentId,
    authProfileId: "synthetic-profile",
    sessionId,
    modelId: PRIMARY,
    model: { ...params.model, id: PRIMARY, name: PRIMARY },
    config: {
      plugins: {
        entries: {
          codex: {
            config: {
              appServer: { cyberFailover: { mode: "auto" as const, model: FALLBACK } },
            },
          },
        },
      },
    },
    onAgentEvent: vi.fn(),
  };
}

async function failedTurn(
  params: AttemptParams,
  message: string,
  codexErrorInfo: string,
  telemetry = buildEmptyToolTelemetry(),
) {
  const projector = await createProjector(params);
  const error = { message, codexErrorInfo };
  await projector.handleNotification(forCurrentTurn("error", { error, willRetry: false }));
  await projector.handleNotification(
    forCurrentTurn("turn/completed", {
      turn: { id: TURN_ID, status: "failed", items: [], error },
    }),
  );
  return projector.buildResult(telemetry);
}

async function refusedTurn(params: AttemptParams) {
  return failedTurn(params, "The provider refused this request.", "cyberPolicy");
}

describe("Codex fallback terminal results", () => {
  it.each(["message", "spawn", "native continuation", "abort", "timeout"] as const)(
    "retains a denied fallback's result after a %s",
    async (effect) => {
      const params = await paramsForWorkspace(`acted-${effect}`, "first");
      const refusal = await refusedTurn(params);
      const telemetry = buildEmptyToolTelemetry();
      if (effect === "message") {
        telemetry.didSendViaMessagingTool = true;
        telemetry.sourceReplyDelivered = true;
        telemetry.messagingToolSentTexts = ["Synthetic delivered update"];
      } else if (effect === "spawn") {
        telemetry.acceptedSessionSpawns = [
          { runId: "child-run", childSessionKey: "agent:main:subagent:child" },
        ];
      }
      const denied = await failedTurn(
        params,
        "Unexpected status 403: forbidden",
        "other",
        telemetry,
      );
      if (effect === "native continuation") {
        // The attempt finalizer adds this after the projector computes replay metadata.
        denied.runtimeContinuationStarted = true;
      } else if (effect === "abort" || effect === "timeout") {
        denied.terminal = attemptTerminal.normalize({
          aborted: true,
          timedOut: effect === "timeout",
          promptError: "Unexpected status 403: forbidden",
          promptErrorSource: "prompt",
        });
      }
      expect(denied.currentAttemptAssistant).toBeUndefined();
      expect(denied.lastAssistant).toBeUndefined();
      params.onAgentEvent.mockClear();
      runAttempt.mockReset().mockResolvedValueOnce(refusal).mockResolvedValueOnce(denied);
      const harness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
      });

      await expect(harness.runAttempt?.(params)).resolves.toBe(denied);
      expect(runAttempt).toHaveBeenCalledTimes(2);
      expect(params.onAgentEvent).toHaveBeenCalledWith({
        stream: "notice",
        data: {
          phase: "provider_policy",
          category: "cyber",
          state: "unavailable",
          provider: "openai",
          model: PRIMARY,
          fallbackModel: FALLBACK,
        },
      });
    },
  );

  it("retains read-only tool progress before a fallback authorization failure", async () => {
    const params = await paramsForWorkspace("read-only-progress", "first");
    const refusal = await refusedTurn(params);
    const projector = await createProjector(params);
    projector.recordDynamicToolCall({
      callId: "read-1",
      tool: "read",
      arguments: { path: "a.txt" },
    });
    projector.recordDynamicToolResult({
      callId: "read-1",
      tool: "read",
      success: true,
      contentItems: [{ type: "inputText", text: "Synthetic file contents" }],
    });
    const error = { message: "Unexpected status 403: forbidden", codexErrorInfo: "other" };
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: { id: TURN_ID, status: "failed", items: [], error },
      }),
    );
    const denied = projector.buildResult(buildEmptyToolTelemetry());
    expect(denied.replayMetadata?.replaySafe).toBe(true);
    expect(denied.toolMetas).toHaveLength(1);
    runAttempt.mockReset().mockResolvedValueOnce(refusal).mockResolvedValueOnce(denied);
    const harness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
    });

    await expect(harness.runAttempt?.(params)).resolves.toBe(denied);
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not replay a refused primary after its native continuation started", async () => {
    const params = await paramsForWorkspace("primary-continuation", "first");
    const refusal = await refusedTurn(params);
    refusal.runtimeContinuationStarted = true;
    expect(refusal.replayMetadata?.replaySafe).toBe(true);
    runAttempt.mockReset().mockResolvedValue(refusal);
    const harness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
    });

    await expect(harness.runAttempt?.(params)).resolves.toBe(refusal);
    expect(runAttempt).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "timeout", "failure"] as const)(
    "does not replay a primary refusal superseded by %s",
    async (terminal) => {
      const params = await paramsForWorkspace(`primary-${terminal}`, "first");
      const refusal = await refusedTurn(params);
      refusal.terminal = attemptTerminal.normalize({
        aborted: terminal === "abort",
        timedOut: terminal === "timeout",
        promptError: terminal === "failure" ? "Native connection closed" : undefined,
        promptErrorSource: "prompt",
      });
      runAttempt.mockReset().mockResolvedValue(refusal);
      const harness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
      });

      await expect(harness.runAttempt?.(params)).resolves.toBe(refusal);
      expect(runAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403])(
    "keeps the refusal and avoids repeating a target denied with %i before assistant output",
    async (status) => {
      const firstParams = await paramsForWorkspace(`denied-${status}`, "first");
      const nextParams = await paramsForWorkspace(`denied-${status}`, "next");
      const refusal = await refusedTurn(firstParams);
      const nextRefusal = await refusedTurn(nextParams);
      const denied = await failedTurn(
        firstParams,
        `Unexpected status ${status}: configured target is not authorized`,
        "other",
      );
      expect(denied.terminal).toMatchObject({ kind: "failed", source: "prompt" });
      expect(denied.currentAttemptAssistant).toBeUndefined();
      expect(denied.lastAssistant).toBeUndefined();
      firstParams.onAgentEvent.mockClear();
      nextParams.onAgentEvent.mockClear();
      runAttempt
        .mockReset()
        .mockResolvedValueOnce(refusal)
        .mockResolvedValueOnce(denied)
        .mockResolvedValueOnce(nextRefusal)
        .mockResolvedValue(denied);
      const harness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
      });

      const firstResult = await harness.runAttempt?.(firstParams);
      const nextResult = await harness.runAttempt?.(nextParams);

      expect(runAttempt.mock.calls.map(([, options]) => options.runtimeModelId)).toEqual([
        PRIMARY,
        FALLBACK,
        PRIMARY,
      ]);
      expect(firstResult).toBe(refusal);
      expect(nextResult).toBe(nextRefusal);
      expect(runAttempt.mock.calls[1]?.[0]).toEqual({
        ...firstParams,
        suppressNextUserMessagePersistence: true,
      });
      for (const params of [firstParams, nextParams]) {
        expect(params.onAgentEvent).toHaveBeenCalledWith({
          stream: "notice",
          data: {
            phase: "provider_policy",
            category: "cyber",
            state: "unavailable",
            provider: "openai",
            model: PRIMARY,
            fallbackModel: FALLBACK,
          },
        });
        expect(params.model.id).toBe(PRIMARY);
      }

      const otherParams = await paramsForWorkspace(`other-${status}`, "other");
      const otherRefusal = await refusedTurn(otherParams);
      const answeredProjector = await createProjector(otherParams);
      await answeredProjector.handleNotification(
        turnCompleted([{ type: "agentMessage", id: "reply", text: "Synthetic fallback reply" }]),
      );
      const answer = answeredProjector.buildResult(buildEmptyToolTelemetry());
      otherParams.onAgentEvent.mockClear();
      runAttempt.mockReset().mockResolvedValueOnce(otherRefusal).mockResolvedValueOnce(answer);

      await expect(harness.runAttempt?.(otherParams)).resolves.toBe(answer);
      expect(runAttempt.mock.calls.map(([, options]) => options.runtimeModelId)).toEqual([
        PRIMARY,
        FALLBACK,
      ]);
      expect(otherParams.onAgentEvent).toHaveBeenCalledWith({
        stream: "notice",
        data: {
          phase: "provider_policy",
          category: "cyber",
          state: "escalated",
          provider: "openai",
          model: PRIMARY,
          fallbackModel: FALLBACK,
        },
      });
    },
  );
});
