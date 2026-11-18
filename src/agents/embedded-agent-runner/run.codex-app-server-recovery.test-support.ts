import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { observeSettlement } from "../promise-settlement.test-support.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedMarkAuthProfileFailure,
  mockedRunEmbeddedAttempt,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

const CODEX_MISSING_TERMINAL_MESSAGE =
  "Codex stopped before confirming the turn was complete. The response may be incomplete; retry if needed.";
const UNSAFE_TIMEOUT_MESSAGE =
  "Codex stopped before confirming the turn was complete. Some work may already have been performed; verify the current state before retrying.";
type AttemptParams = Parameters<typeof mockedRunEmbeddedAttempt>[0];
const appServerTurn = { transport: "stdio" as const, threadId: "thread-1", turnId: "turn-1" };

function runtimeTimeout(message: string): EmbeddedRunAttemptResult["terminal"] {
  return {
    kind: "timeout",
    phase: "prompt",
    source: "runtime",
    aborted: true,
    failure: { source: "prompt", error: new Error(message) },
  };
}

function codexFailure(
  kind: "closed" | "idle",
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const closed = kind === "closed";
  return makeAttemptResult({
    assistantTexts: [],
    terminal: closed
      ? {
          kind: "failed",
          source: "prompt",
          error: new Error("codex app-server client closed before turn completed"),
        }
      : runtimeTimeout("codex app-server turn idle timed out waiting for turn/completed"),
    ...(!closed ? { promptTimeoutOutcome: { message: CODEX_MISSING_TERMINAL_MESSAGE } } : {}),
    codexAppServerFailure: {
      kind: closed ? "client_closed_before_turn_completed" : "turn_completion_idle_timeout",
      ...(!closed ? { turnWatchTimeoutKind: "completion" as const } : {}),
      ...appServerTurn,
      replaySafe: true,
    },
    ...overrides,
  });
}

const successAttempt = () => makeAttemptResult({ assistantTexts: ["Done."] });

function runCodex(runId: string, overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]> = {}) {
  return runEmbeddedAgent({
    ...createOverflowRunParams(state),
    provider: "codex",
    model: "gpt-5.5",
    runId,
    ...overrides,
  });
}

function runNative(runId: string, overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]> = {}) {
  return runCodex(runId, { provider: "openai", model: "gpt-5.6-luna", ...overrides });
}

function expectIncompleteTimeout(
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>,
  message: string,
  meta: Partial<Awaited<ReturnType<typeof runEmbeddedAgent>>["meta"]>,
) {
  expect(result.payloads?.[0]).toMatchObject({ isError: true, text: message });
  expect(result.meta).toMatchObject({
    ...meta,
    error: { kind: "incomplete_turn", message, fallbackSafe: false },
  });
  expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
}

describe("runEmbeddedAgent Codex app-server recovery", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.codex-app-server-recovery");
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("passes native deadline ownership through dispatch and fences retained callbacks", async () => {
    useOpenAIPlatformAuthFixture();
    vi.useFakeTimers();
    const entered = createDeferred<AttemptParams>();
    const finish = createDeferred<EmbeddedRunAttemptResult>();
    let run: ReturnType<typeof runEmbeddedAgent> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      params.onAttemptDeadlineChanged?.({ kind: "unlimited" });
      entered.resolve(params);
      return await finish.promise;
    });
    try {
      run = runNative("runtime-deadline-handoff", { timeoutMs: 1 });
      const settled = observeSettlement(run);
      const params = await awaitGateBeforeSettlement(
        entered.promise,
        run,
        "Run completed before reaching the native attempt",
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled()).toBe(false);
      expect(params.onAttemptTimeout).toBeTypeOf("function");
      params.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() + 120_000 });
      await vi.advanceTimersByTimeAsync(125_000);
      expect(settled()).toBe(false);
      finish.resolve(successAttempt());
      await expect(run).resolves.toMatchObject({ meta: { aborted: false } });

      const timerCount = vi.getTimerCount();
      params.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() });
      params.onAttemptTimeout?.(new Error("late timeout"));
      params.onAttemptAbort?.();
      expect(vi.getTimerCount()).toBe(timerCount);
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt());
      await expect(runNative("runtime-deadline-successor")).resolves.toMatchObject({
        meta: { aborted: false },
      });
    } finally {
      finish.resolve(successAttempt());
      await run?.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it.each([
    { deadline: "execution", delivery: "partial" },
    { deadline: "settlement", delivery: "completed" },
    { deadline: "settlement", delivery: "message-tool" },
  ] as const)(
    "preserves $delivery output without hiding the $deadline timeout",
    async ({ deadline, delivery }) => {
      useOpenAIPlatformAuthFixture();
      const { buildEmbeddedRunPayloads } =
        await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
      const text = "Work completed so far.";
      const message = `The runtime's ${deadline} deadline expired; verify the work before continuing.`;
      const assistant = buildEmbeddedRunnerAssistant({
        api: "responses",
        model: "gpt-5.6-luna",
        content: [{ type: "text", text }],
        usage: { ...createZeroUsageFixture(), input: 1, output: 1, totalTokens: 2 },
      });
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          terminal: runtimeTimeout(message),
          assistantTexts: delivery === "message-tool" ? [] : [text],
          lastAssistant: delivery === "completed" ? assistant : undefined,
          currentAttemptAssistant: delivery === "completed" ? assistant : undefined,
          currentAttemptCompletedAssistant: delivery === "completed" ? assistant : undefined,
          didSendViaMessagingTool: delivery === "message-tool",
          messagingToolSentTexts: delivery === "message-tool" ? [text] : [],
          promptTimeoutOutcome: { message, replayInvalid: true, livenessState: "abandoned" },
          ...(deadline === "settlement"
            ? {
                codexAppServerFailure: {
                  kind: "turn_settlement_timeout" as const,
                  ...appServerTurn,
                  replaySafe: false,
                },
              }
            : {}),
        }),
      );
      const result = await runNative(`owned-${deadline}-${delivery}`);
      expect(result.payloads).toContainEqual(
        expect.objectContaining({ text: message, isError: true }),
      );
      if (delivery !== "message-tool") {
        expect(result.payloads).toContainEqual(expect.objectContaining({ text }));
      }
      expect(result.meta).toMatchObject({
        replayInvalid: true,
        livenessState: "abandoned",
        error: { kind: "incomplete_turn", message, fallbackSafe: false },
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedMarkAuthProfileFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["active", "closed", "replaced"] as const)(
    "retries without a durable writer only while its exact native admission is active (%s)",
    async (owner) => {
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { createReplyOperation } = await import("../../sessions/session-controller.js");
      const runId = `run-native-retry-${owner}`;
      const sessionKey = `agent:main:${runId}`;
      const admission = prepareSystemAgentRunAdmission({}, runId, "main", "native-retry-test");
      const replacement = prepareSystemAgentRunAdmission({}, runId, "main", "replacement-test");
      const replyOperation = createReplyOperation({
        sessionKey,
        sessionId: runId,
        resetTriggered: false,
      });
      const freezeAbort = vi.spyOn(replyOperation, "freezeAbort");
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async () => {
          expect(freezeAbort).not.toHaveBeenCalled();
          if (owner === "closed") {
            admission.close();
          }
          if (owner === "replaced") {
            await replacement.admit("embedded");
          }
          return codexFailure("closed", { sessionIdUsed: runId });
        })
        .mockImplementationOnce(async () => {
          expect(freezeAbort).not.toHaveBeenCalled();
          return { ...successAttempt(), sessionIdUsed: runId };
        });

      try {
        const run = runCodex(runId, {
          sessionId: runId,
          sessionKey,
          preparedRunAdmission: admission,
          replyOperation,
        });
        if (owner === "active") {
          await run;
        } else {
          await expect(run).rejects.toThrow("admitted run authority is no longer active");
        }
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(owner === "active" ? 2 : 1);
        expect(freezeAbort).not.toHaveBeenCalled();
      } finally {
        admission.close();
        replacement.close();
        replyOperation.complete();
        freezeAbort.mockRestore();
      }
    },
  );

  it.each(["ordinary", "replay-safe", "upstream"] as const)(
    "preserves %s cancellation ownership without exposing failure to fallback",
    async (kind) => {
      const controller = new AbortController();
      const upstreamAbort = new Error("upstream cancelled");
      const { createReplyOperation } = await import("../../sessions/session-controller.js");
      const runId = `run-codex-cancel-${kind}`;
      const replyOperation =
        kind === "ordinary"
          ? undefined
          : createReplyOperation({
              sessionKey: `agent:main:${runId}`,
              sessionId: runId,
              resetTriggered: false,
              ...(kind === "upstream" ? { upstreamAbortSignal: controller.signal } : {}),
            });
      const abortByUser = replyOperation
        ? vi.spyOn(replyOperation, "abortByUser")
        : vi.fn(() => true);
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
        if (kind === "upstream") {
          controller.abort(upstreamAbort);
        }
        attemptParams.onAttemptAbort?.();
        return kind === "ordinary"
          ? makeAttemptResult({
              assistantTexts: [],
              terminal: { kind: "failed", source: "prompt", error: new Error("codex exploded") },
            })
          : codexFailure("closed");
      });
      try {
        const pending = runCodex(
          runId,
          replyOperation
            ? {
                sessionId: replyOperation.sessionId,
                sessionKey: replyOperation.key,
                isFinalFallbackAttempt: false,
                ...(kind === "upstream" ? { abortSignal: controller.signal } : {}),
                replyOperation,
              }
            : {},
        );
        if (kind === "upstream") {
          await expect(pending).rejects.toBe(upstreamAbort);
        } else {
          await expect(pending).rejects.toMatchObject({
            name: "AbortError",
            message: "agent run aborted",
          });
        }
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
        expect(abortByUser).toHaveBeenCalledTimes(kind === "replay-safe" ? 1 : 0);
      } finally {
        replyOperation?.complete();
      }
    },
  );

  it("suppresses duplicate Codex prompt mirroring on retry", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexFailure("closed"))
      .mockResolvedValueOnce(successAttempt());

    await runCodex("run-codex-client-close-retry-mirror");
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      suppressNextUserMessagePersistence: true,
    });
  });

  it("returns a timeout payload after a replay-safe turn/completed idle timeout retry is exhausted", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(codexFailure("idle"))
      .mockResolvedValueOnce(codexFailure("idle"));

    const result = await runCodex("run-codex-turn-completion-idle-timeout-retry-exhausted");

    expectIncompleteTimeout(result, CODEX_MISSING_TERMINAL_MESSAGE, {
      timeoutPhase: "provider",
      providerStarted: true,
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it.each(["turn_completion_idle_timeout", "turn_settlement_timeout"] as const)(
    "does not hand Codex app-server %s failures to model fallback",
    async (kind) => {
      mockedClassifyFailoverReason.mockReturnValue("timeout");
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        codexFailure("idle", {
          didSendViaMessagingTool: true,
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
          promptTimeoutOutcome: {
            message: UNSAFE_TIMEOUT_MESSAGE,
            replayInvalid: true,
            livenessState: "abandoned",
          },
          codexAppServerFailure: {
            kind,
            turnWatchTimeoutKind:
              kind === "turn_completion_idle_timeout" ? "completion" : undefined,
            ...appServerTurn,
            replaySafe: false,
            replayBlockedReason: "potential_side_effect",
          },
        }),
      );

      const config = createModelFallbackConfig("openai/gpt-5.5", ["anthropic/claude-opus-4-6"]);
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      const result = await runCodex("run-codex-turn-completion-idle-timeout-fallback", { config });

      expectIncompleteTimeout(result, UNSAFE_TIMEOUT_MESSAGE, {
        replayInvalid: true,
        livenessState: "abandoned",
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    },
  );
});
