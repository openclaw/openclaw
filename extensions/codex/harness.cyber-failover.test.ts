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

async function failedTurn(params: AttemptParams, message: string, codexErrorInfo: string) {
  const projector = await createProjector(params);
  const error = { message, codexErrorInfo };
  await projector.handleNotification(forCurrentTurn("error", { error, willRetry: false }));
  await projector.handleNotification(
    forCurrentTurn("turn/completed", {
      turn: { id: TURN_ID, status: "failed", items: [], error },
    }),
  );
  return projector.buildResult(buildEmptyToolTelemetry());
}

async function refusedTurn(params: AttemptParams) {
  return failedTurn(params, "The provider refused this request.", "cyberPolicy");
}

describe("Codex fallback terminal results", () => {
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
