// Full-entry coverage for retrying empty errored assistant turns.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  acceptProviderReviewAcknowledgment,
  createSessionProviderReview,
  issueProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { hasRecordedModelFallbackStop } from "../failover-error.js";
import { resolveAgentRunErrorLifecycleFields } from "../run-termination.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

type AssistantContent = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>["content"];

function emptyErrorAttempt(
  provider: string,
  model: string,
  outputTokens = 0,
  content: AssistantContent = [],
  errorMessage?: string,
): EmbeddedRunAttemptResult {
  // Models can report stopReason=error with no output after tool activity; that
  // is replay-safe only when the attempt metadata records no side effects.
  const assistant = {
    role: "assistant",
    stopReason: "error",
    provider,
    model,
    content,
    usage: { input: 100, output: outputTokens, totalTokens: 100 + outputTokens },
    ...(errorMessage ? { errorMessage } : {}),
  } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
  return makeAttemptResult({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  const assistant = {
    role: "assistant",
    stopReason: "stop",
    provider,
    model,
    content: [{ type: "text", text: "Done." }],
    usage: { input: 100, output: 5, totalTokens: 105 },
  } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
  return makeAttemptResult({
    assistantTexts: ["Done."],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

describe("runEmbeddedAgent silent-error retry", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.empty-error-retry" });
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("retries when a turn ends with stopReason=error and zero output tokens", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("ollama", "glm-5.1:cloud"));

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-basic",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("retries server_error when the attempt is otherwise silent and side-effect-free", async () => {
    mockedClassifyAssistantFailoverReason.mockReturnValue("server_error");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-8", 0, [], "Internal server error"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-8"));

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-empty-error-retry-server-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not intercept concrete non-transient failover errors", async () => {
    mockedClassifyFailoverReason.mockReturnValue("model_not_found");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt(
        "anthropic",
        "missing-model",
        1120,
        [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_missing_model", type: "reasoning" }),
          },
        ],
        "model not found",
      ),
    );

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "anthropic",
      model: "missing-model",
      runId: "run-empty-error-retry-non-transient",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("caps retries at MAX_EMPTY_ERROR_RETRIES and surfaces incomplete-turn error", async () => {
    // 1 initial + 3 retries = 4 attempts, all returning empty-error.
    for (let i = 0; i < 4; i += 1) {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    }

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("does not mark incomplete turns fallback-safe after a terminal heartbeat response", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        ...emptyErrorAttempt("anthropic", "claude-opus-4-8", 1120, [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_heartbeat_error", type: "reasoning" }),
          },
        ]),
        heartbeatToolResponse: {
          outcome: "progress",
          notify: false,
          summary: "Still working",
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-terminal-heartbeat-not-fallback-safe",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: false,
    });
  });
  describe("current-assistant provenance", () => {
    it.each([
      { failure: "assistant error", accepted: false },
      { failure: "prompt error", accepted: false },
      { failure: "thrown error", accepted: false },
      { failure: "abort", accepted: false },
      { failure: "timeout", accepted: false },
      { failure: "assistant error", accepted: true },
      { failure: "timeout", accepted: true },
      { failure: "reasoning-only", accepted: true },
    ] as const)(
      "never retries an acknowledged continuation after $failure (accepted=$accepted)",
      async ({ failure, accepted }) => {
        useOpenAIPlatformAuthFixture();
        const params = createOverflowRunParams(state);
        const scope = { agentId: params.agentId, sessionKey: params.sessionKey };
        const options = toDatabaseOptions(resolveSqliteScope(scope));
        const database = openOpenClawAgentDatabase(options);
        const target = { ...scope, sessionId: params.sessionId, storePath: database.path };
        const review = createSessionProviderReview({
          sessionId: params.sessionId,
          refusal: {
            runId: "failed-run",
            provider: "openai",
            model: "gpt-5.6-sol",
            runtimeId: "codex",
            api: "openai-responses",
            nativeThreadId: "native-thread",
            nativeTurnId: "failed-turn",
            review: {
              explanation: "Review the pending operation.",
              continuation: { message: "/literal confirmation" },
            },
          },
        });
        writeSessionEntry(
          database,
          params.sessionKey,
          { sessionId: params.sessionId, updatedAt: 1, providerReview: review },
          { providerReviewMutation: true },
        );
        const acknowledgment = await issueProviderReviewAcknowledgment({
          target,
          reviewId: review.id,
          nextRunId: "acknowledged-run",
          assertCurrent: () => {},
        });
        mockedClassifyAssistantFailoverReason.mockReturnValue("server_error");
        mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
          if (accepted) {
            await acceptProviderReviewAcknowledgment(acknowledgment, {
              runId: "acknowledged-run",
              nativeThreadId: "native-thread",
              nativeTurnId: "accepted-turn",
            });
          }
          if (failure === "thrown error") {
            throw new Error("Internal server error");
          }
          if (failure === "reasoning-only") {
            const assistant = makeAssistantMessageFixture({
              provider: "openai",
              model: "gpt-5.6-sol",
              api: "openai-responses",
              stopReason: "stop",
              content: [{ type: "thinking", thinking: "A final answer is still needed." }],
            });
            return makeAttemptResult({
              assistantTexts: [],
              currentAttemptAssistant: assistant,
              lastAssistant: assistant,
            });
          }
          return failure === "assistant error"
            ? emptyErrorAttempt("openai", "gpt-5.6-sol", 0, [], "Internal server error")
            : makeAttemptResult({
                assistantTexts: [],
                terminal:
                  failure === "prompt error"
                    ? {
                        kind: "failed",
                        source: "prompt",
                        error: new Error("Internal server error"),
                      }
                    : failure === "abort"
                      ? { kind: "aborted", source: "runtime" }
                      : { kind: "timeout", source: "runtime", phase: "prompt" },
              });
        });
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("openai", "gpt-5.6-sol"));
        const error = await runEmbeddedAgent({
          ...params,
          provider: "openai",
          model: "gpt-5.6-sol",
          runId: "acknowledged-run",
          providerReviewAcknowledgment: acknowledgment,
        }).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(Error);
        expect(hasRecordedModelFallbackStop(error)).toBe(true);
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ ...scope, readConsistency: "latest" })?.providerReview).toEqual(
          accepted ? undefined : review,
        );
        if (failure === "abort") {
          expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toMatchObject({
            aborted: true,
            stopReason: "aborted",
          });
        } else if (failure === "timeout") {
          expect(resolveAgentRunErrorLifecycleFields(error, undefined)).toMatchObject({
            stopReason: "timeout",
          });
        }
      },
    );

    it("persists a current misalignment review before a later run can dispatch", async () => {
      useOpenAIPlatformAuthFixture();
      const params = createOverflowRunParams(state);
      const scope = { agentId: params.agentId, sessionKey: params.sessionKey };
      await replaceSessionEntry(scope, { sessionId: params.sessionId, updatedAt: 1 });
      const review = {
        explanation: "Review the pending operation.",
        continuation: { message: "/literal confirmation" },
      };
      const refusal = makeAssistantMessageFixture({
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "gpt-5.6-sol",
        stopReason: "error",
        content: [],
        errorMessage: "current refusal",
        diagnostics: [
          {
            type: "provider_refusal",
            timestamp: 1,
            details: {
              provider: "openai",
              category: "misalignment",
              review,
              nativeThreadId: "native-thread",
              nativeTurnId: "native-failed-turn",
            },
          },
        ],
      });
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: undefined,
          currentAttemptAssistant: undefined,
          currentAttemptCompletedAssistant: refusal,
        }),
      );
      const result = await runEmbeddedAgent({
        ...params,
        provider: "openai",
        model: "gpt-5.6-sol",
        runId: "run-misalignment",
      });
      expect(result.meta.agentMeta?.providerRefusal?.review).toEqual(review);
      expect(
        loadSessionEntry({ ...scope, readConsistency: "latest" })?.providerReview,
      ).toMatchObject({
        sessionId: params.sessionId,
        runId: "run-misalignment",
        review,
        nativeThreadId: "native-thread",
        nativeTurnId: "native-failed-turn",
      });
      await expect(
        runEmbeddedAgent({
          ...params,
          provider: "openai",
          model: "gpt-5.6-sol",
          runId: "ordinary-later-run",
        }),
      ).rejects.toThrow("paused as a precaution");
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    });

    it("ignores a historical refusal after compaction", async () => {
      const refusal = makeAssistantMessageFixture({
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-5",
        stopReason: "error",
        content: [],
        errorMessage: "historical refusal",
        diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
      });
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: [],
            lastAssistant: refusal,
            currentAttemptAssistant: undefined,
            currentAttemptCompletedAssistant: undefined,
            compactionCount: 1,
          }),
        )
        .mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-5"));

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "anthropic",
        model: "claude-opus-5",
        runId: "run-historical-refusal-after-compaction",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.error).toBeUndefined();
      expect(result.payloads?.some((payload) => payload.text?.includes("refused"))).not.toBe(true);
    });

    it("preserves a completed current refusal after transcript projection removes its slice", async () => {
      const refusal = makeAssistantMessageFixture({
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-5",
        stopReason: "error",
        content: [],
        errorMessage: "current refusal",
        diagnostics: [{ type: "provider_refusal", timestamp: 2, details: { category: "cyber" } }],
      });
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: [],
            lastAssistant: undefined,
            currentAttemptAssistant: undefined,
            currentAttemptCompletedAssistant: refusal,
            compactionCount: 1,
          }),
        )
        .mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-5"));

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "anthropic",
        model: "claude-opus-5",
        runId: "run-completed-refusal-without-transcript-slice",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]).toMatchObject({
        isError: true,
        text: "The provider refused this request (category: cyber). Revise the request and try again.",
      });
    });
  });
});
