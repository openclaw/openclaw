import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { makeEmbeddedRunnerAttempt as makeAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { CUT_OFF_SUMMARY_NOTICE_TEXT } from "./incomplete-turn-resolution.js";
import { EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS } from "./lane-runtime.js";
import { useFinalizationAdmission } from "./settled-finalization-harness.test-support.js";
import {
  prepareTerminalWithSettledTurnFinalization as finalize,
  requestSettledTurnFinalizationContext,
} from "./settled-turn-finalization.js";
import {
  createSettledFinalizationTestInput as makeInput,
  createSettledProviderFailureAttempt as providerFailure,
  projectSettledProviderFailureAttempt as projectFailure,
} from "./settled-turn-finalization.test-support.js";
import {
  finalizationReply,
  settledBatch,
  textAssistant,
} from "./settled-turn-fixtures.test-support.js";
import { isEmbeddedRunTerminalTimeout } from "./terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const backendMocks = vi.hoisted(() => ({
  finalize: vi.fn(),
  resolveRuntimeModelAttempt: vi.fn(
    (runtimePlan?: {
      resolvedRef?: { provider?: string; modelId?: string };
      auth?: { credentialSource?: unknown };
    }) =>
      runtimePlan?.resolvedRef?.provider &&
      runtimePlan.resolvedRef.modelId &&
      runtimePlan.auth?.credentialSource
        ? {
            provider: runtimePlan.resolvedRef.provider,
            model: runtimePlan.resolvedRef.modelId,
            credentialSource: runtimePlan.auth.credentialSource,
          }
        : undefined,
  ),
}));
const transcriptMocks = vi.hoisted(() => ({
  append: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: backendMocks.resolveRuntimeModelAttempt,
}));
// mock-isolation: finalization fixtures must not load or invoke the live agent harness.
vi.mock("../../harness/selection.js", () => ({
  runAgentHarnessSettledTurnFinalization: backendMocks.finalize,
}));
// mock-isolation: record synthetic mirror writes without loading transcript persistence.
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: transcriptMocks.append,
}));

function expectPayload(
  result: Awaited<ReturnType<typeof finalize>>,
  payload: Record<string, unknown>,
) {
  expect(result.prepared.payloadsWithToolMedia).toEqual([expect.objectContaining(payload)]);
}

function settledAttempt(failed = true): EmbeddedRunAttemptWithReceiptEvidence {
  const batch = settledBatch(["tool-read", "read"], ["tool-exec", "exec", failed]);
  return makeAttempt({
    ...batch,
    terminal: failed
      ? {
          kind: "failed",
          source: "compaction",
          error: new Error("native context compaction failed"),
        }
      : { kind: "ok" },
    sessionIdUsed: "session-settled",
    sessionFileUsed: "/tmp/session-settled.jsonl",
    toolMetas: [
      { toolName: "read", isError: false, replaySafe: true },
      { toolName: "exec", isError: failed, replaySafe: false },
    ],
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: {
      source: "openclaw-transcript",
      messages: batch.messagesSnapshot,
    },
    lastToolError: failed
      ? { toolName: "exec", error: "post-processing error", errorCode: "SYSTEM_RUN_DENIED" }
      : undefined,
    assistantTurns: 1,
  });
}

const getContext = useFinalizationAdmission([backendMocks.finalize, transcriptMocks.append]);
const CONNECTION_ERROR = "Couldn't connect to the AI service.";

function finalizationInput(
  attempt = settledAttempt(),
  policy: Partial<Parameters<typeof finalize>[0]["terminalBase"]["runParams"]> = {},
) {
  const input = makeInput(attempt, getContext());
  Object.assign(input.terminalBase.runParams, { onAttemptTerminalReplaced: vi.fn(), ...policy });
  return input;
}

describe("prepareTerminalWithSettledTurnFinalization", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["delivered", "pending", "missing"] as const)(
    "requests settled context only when source delivery is missing (%s)",
    async (delivery) => {
      const attempt = settledAttempt(false);
      const context = attempt.settledTurnFinalizationContext;
      attempt.settledTurnFinalizationContext = { source: "unavailable" };
      const input = finalizationInput(attempt);
      input.terminalBase.runParams.resolveReplyDelivery = async () => delivery;
      const capture = vi.fn(async () => context);
      backendMocks.finalize.mockResolvedValue(
        finalizationReply("answered", "The tools completed successfully.", {
          assistantTranscriptOwned: true,
        }),
      );
      await requestSettledTurnFinalizationContext(
        { ...input.terminalBase, ...input.initial, lastRunPromptUsage: input.lastRunPromptUsage },
        input.finalization,
        capture,
      );
      const result = await finalize(input);
      const missing = delivery === "missing";
      expect(capture).toHaveBeenCalledTimes(missing ? 1 : 0);
      expect(backendMocks.finalize).toHaveBeenCalledTimes(missing ? 1 : 0);
      expect(result.finalizationOutcome).toBe(missing ? "answered" : "not-attempted");
      if (missing) {
        expect(attempt.settledTurnFinalizationContext).toBe(context);
        expect(result.attempt.assistantTexts).toEqual(["The tools completed successfully."]);
      }
    },
  );

  function cutOffAttempt(stopReason: "length" | "stop") {
    const attempt = settledAttempt(false);
    const cutOff = textAssistant(undefined, {
      stopReason,
      content: [{ type: "thinking", thinking: "Next", thinkingSignature: "opaque" }],
    });
    return Object.assign(attempt, {
      lastAssistant: cutOff,
      currentAttemptAssistant: cutOff,
      currentAttemptCompletedAssistant: cutOff,
      messagesSnapshot: [...attempt.messagesSnapshot, cutOff],
    });
  }

  it.each(["length", "stop"] as const)(
    "labels a recovered summary only when the settled turn was cut off (%s)",
    async (stopReason) => {
      // #178300: a tool-free summary of a cut-off turn must not read as a clean finish.
      backendMocks.finalize.mockResolvedValueOnce(
        finalizationReply("answered", "All steps are complete."),
      );

      const result = await finalize(finalizationInput(cutOffAttempt(stopReason)));

      expect(result.finalizationOutcome).toBe("answered");
      expect(result.prepared.payloadsWithToolMedia?.map((payload) => payload.text)).toEqual(
        stopReason === "length"
          ? ["All steps are complete.", CUT_OFF_SUMMARY_NOTICE_TEXT]
          : ["All steps are complete."],
      );
    },
  );

  it("holds the cut-off notice back with a summary whose source reply was already delivered", async () => {
    const input = finalizationInput(cutOffAttempt("length"));
    // The source reply lands while the finalizer runs, so its summary must not be sent.
    input.terminalBase.runParams.resolveReplyDelivery = vi
      .fn()
      .mockResolvedValueOnce("missing")
      .mockResolvedValue("delivered");
    backendMocks.finalize.mockResolvedValueOnce(
      finalizationReply("answered", "All steps are complete."),
    );

    const result = await finalize(input);

    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
  });

  it.each(["answered", "empty"] as const)(
    "carries only a real finalizer answer across message-tool-only suppression (%s)",
    async (outcome) => {
      // #181226: the stranded-reply retry finalizes in message_tool_only mode with the
      // harness-captured context. A real answer must reach the source channel; a failed
      // recovery must leave no visible text for the retry's diagnostic to misread.
      const attempt = settledAttempt(false);
      attempt.settledTurnFinalizationContext = { source: "harness", data: [] } as never;
      const input = finalizationInput(attempt, { sourceReplyDeliveryMode: "message_tool_only" });
      backendMocks.finalize.mockResolvedValueOnce(
        outcome === "answered"
          ? finalizationReply("answered", "Update: shipped.")
          : finalizationReply("empty"),
      );

      const result = await finalize(input);

      if (outcome === "answered") {
        expect(result.finalizationOutcome).toBe("answered");
        expectPayload(result, { text: "Update: shipped." });
        expect(
          getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia![0]!)
            ?.deliverDespiteSourceReplySuppression,
        ).toBe(true);
      } else {
        expect(result.finalizationOutcome).toBe("failed");
        expect(result.prepared.finalAssistantVisibleText).toBe("");
        expect(
          (result.prepared.payloadsWithToolMedia ?? []).filter(
            (payload) => getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression,
          ),
        ).toEqual([]);
      }
    },
  );

  it("does not finalize an empty post-tool turn when media was delivered", async () => {
    const assistant = textAssistant();
    const attempt = makeAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      toolMetas: [{ toolName: "tts", isError: false, replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      hasToolMediaBlockReply: true,
    });
    const result = await finalize(finalizationInput(attempt));

    expect(backendMocks.finalize).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(result.prepared.payloadsWithToolMedia).toEqual([]);
  });

  it.each([
    { delivery: "delivered", observation: "absent", expected: "delivered" },
    { delivery: "delivered", observation: "missing", expected: "delivered" },
    { delivery: "pending", observation: "absent", expected: "pending" },
    { delivery: "pending", observation: "missing", expected: "pending" },
    { delivery: "pending", observation: "delivered", expected: "delivered" },
    { delivery: "missing", observation: "absent", expected: "missing" },
    { delivery: "missing", observation: "delivered", expected: "delivered" },
    { delivery: "progress", observation: "absent", expected: "missing" },
    { delivery: "progress", observation: "delivered", expected: "delivered" },
  ] as const)(
    "uses reconciled $delivery custody with an $observation observer for finalization",
    async ({ delivery, observation, expected }) => {
      const attempt = settledAttempt(false);
      attempt.sourceReplyDeliveryState = delivery === "progress" ? undefined : delivery;
      // Current custody outranks old final markers; progress alone is not a final reply.
      attempt.messagingToolSentTargets = [
        {
          tool: "message",
          provider: "fixture",
          to: "source",
          sourceReplyFinal: delivery !== "progress",
        },
      ];
      attempt.didSendViaMessagingTool = true;
      const input = finalizationInput(attempt);
      if (observation !== "absent") {
        input.terminalBase.runParams.resolveReplyDelivery = vi.fn(async () => observation);
      }
      const reply = finalizationReply("answered", "The final answer.");
      backendMocks.finalize.mockResolvedValueOnce({
        ...reply,
        result: { ...reply.result, usage: reply.result.assistant.usage },
      });

      const result = await finalize(input);

      expect(backendMocks.finalize).toHaveBeenCalledTimes(expected === "missing" ? 1 : 0);
      expect(result.finalizationOutcome).toBe(
        expected === "missing" ? "answered" : "not-attempted",
      );
      expect(result.prepared.replyDeliveryState).toBe(expected);
      if (expected !== "missing") {
        expect(result.attempt).toBe(attempt);
      }
    },
  );

  it("preserves classified stream failure after commentary when finalization stays empty", async () => {
    const commentary = "I am saving the note.";
    const base = providerFailure({ assistantTexts: [commentary] });
    const toolAssistant = base.messagesSnapshot[1];
    if (toolAssistant?.role !== "assistant" || !base.currentAttemptCompletedAssistant) {
      throw new Error("Missing assistant fixture");
    }
    toolAssistant.content.unshift({ type: "text", text: commentary });
    base.currentAttemptCompletedAssistant.errorMessage = "Stream ended without finish_reason";
    base.terminal = {
      kind: "failed",
      source: "prompt",
      error: new Error("Stream ended without finish_reason"),
    };
    const attempt = projectFailure(base);
    expect(attempt.settledTurnFinalizationContext).toBeDefined();
    backendMocks.finalize.mockResolvedValue(finalizationReply("empty"));
    const input = finalizationInput(attempt);
    input.terminalBase.runParams.trigger = "user";
    input.finalization.modelApi = "openai-completions";

    const result = await finalize(input);

    expect(result.finalizationOutcome).toBe("failed");
    expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
    expect(backendMocks.finalize).toHaveBeenCalledTimes(2);
    expectPayload(result, { text: "LLM request timed out.", isError: true });
  });

  it("preserves the command failure when summary recovery stays empty", async () => {
    const attempt = settledAttempt();
    attempt.terminal = { kind: "ok" };
    attempt.lastToolError = { toolName: "exec", error: "Command exited with code 127" };
    backendMocks.finalize.mockResolvedValue(finalizationReply("empty"));

    const result = await finalize(finalizationInput(attempt));

    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expectPayload(result, { text: expect.stringContaining("failed"), isError: true });
    expect(transcriptMocks.append).not.toHaveBeenCalled();
  });

  it("preserves runtime context and model selection through isolated finalization", async () => {
    const runtimeModelSelection = { provider: "openai", model: "native-selected-model" };
    const runtimeContext = {
      agentHarnessId: "codex",
      runtimeModelSelection,
      contextTokens: 1_000_000,
      contextTokensSource: "runtime" as const,
    };
    const attempt = { ...settledAttempt(), ...runtimeContext };
    const input = finalizationInput(attempt);
    input.terminalBase.outerContextTokenMeta = { contextTokens: 272_000 };
    input.finalization.preparedAttempt.agentHarnessId = "codex";
    input.finalization.preparedAttempt.runtimePlan = {
      resolvedRef: { provider: "openai", modelId: "gpt-5.6-luna" },
      auth: { credentialSource: { kind: "profile" } },
    } as never;
    const finalAssistant = textAssistant("The exec tool failed: post-processing error.", {
      provider: "host-finalizer",
      model: "summary-model",
    });
    backendMocks.finalize.mockResolvedValueOnce(
      finalizationReply("answered", "The exec tool failed: post-processing error.", {
        assistant: finalAssistant,
        usage: finalAssistant.usage,
        diagnosticTrace: { traceId: "trace-final", spanId: "span-final" },
      }),
    );

    const result = await finalize(input);

    expect(result.attempt).toMatchObject({
      ...runtimeContext,
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: { kind: "profile" },
      },
    });
    expect(result.prepared.agentMeta).toMatchObject({
      ...runtimeContext,
      provider: "host-finalizer",
      model: "summary-model",
      credentialSource: { kind: "profile" },
    });
  });

  it("retries empty finalization with fresh controls and retires prior timeout and Stop callbacks", async () => {
    vi.useFakeTimers();
    const attempt = settledAttempt();
    const input = finalizationInput(attempt);
    const factory = vi.mocked(input.finalization.createAttemptControls);
    const { close, ...retiredControls } = factory({ admittedRunContext: getContext() });
    close();
    factory.mockClear();
    Object.assign(input.finalization.preparedAttempt, retiredControls, {
      abortSignal: AbortSignal.abort(new Error("original attempt timed out")),
    });
    let firstAttempt: EmbeddedRunAttemptParams;
    backendMocks.finalize
      .mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
        firstAttempt = params;
        expect(params.abortSignal?.aborted).toBe(false);
        expect(params.onAttemptAbort).not.toBe(retiredControls.onAttemptAbort);
        expect(params.onAttemptTimeout).not.toBe(retiredControls.onAttemptTimeout);
        expect(params.onAttemptDeadlineChanged).not.toBe(retiredControls.onAttemptDeadlineChanged);
        params.onAttemptTimeout?.(new Error("first finalizer timed out while settling"));
        return finalizationReply("empty");
      })
      .mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
        expect(params.onAttemptAbort).not.toBe(firstAttempt.onAttemptAbort);
        expect(params.onAttemptTimeout).not.toBe(firstAttempt.onAttemptTimeout);
        expect(params.onAttemptDeadlineChanged).not.toBe(firstAttempt.onAttemptDeadlineChanged);
        firstAttempt.onAttemptAbort?.();
        firstAttempt.onAttemptTimeout?.(new Error("late timeout"));
        firstAttempt.onAttemptDeadlineChanged?.({ kind: "bounded", deadlineAtMs: Date.now() });
        await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);
        expect(params.abortSignal?.aborted).toBe(false);
        return finalizationReply("answered", "The command completed successfully.");
      });

    const result = await finalize(input);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(result.finalizationOutcome).toBe("answered");
    expectPayload(result, { text: "The command completed successfully." });
    expect(result.prepared.agentMeta).toMatchObject({ assistantTurns: 3 });
    for (const controls of factory.mock.results) {
      if (controls.type === "return") {
        controls.value.onAttemptAbort();
        controls.value.onAttemptTimeout(new Error("late timeout after finalization"));
      }
    }
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);
    expect(input.finalization.abortSignal.aborted).toBe(false);
  });

  it("normalizes an unlimited budget when the finalizer publishes no deadline", async () => {
    const input = finalizationInput();
    input.finalization.preparedAttempt.timeoutMs = 0;
    backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", "Done."));

    const result = await finalize(input);

    expect(input.finalization.createAttemptControls).toHaveBeenCalledExactlyOnceWith({
      admittedRunContext: input.terminalBase.runParams.admittedRunContext,
      abortSignal: input.finalization.abortSignal,
      initialTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    expect(result.finalizationOutcome).toBe("answered");
  });

  it.each([
    ["success", () => settledAttempt(false), undefined, SILENT_REPLY_TOKEN],
    ["provider error", providerFailure, CONNECTION_ERROR, SILENT_REPLY_TOKEN],
    ["blank output", providerFailure, CONNECTION_ERROR, ""],
    ["failed tool", settledAttempt, "Exec failed", SILENT_REPLY_TOKEN],
  ] as const)(
    "honors the finalization silence contract: %s",
    async (_name, createAttempt, errorText, text) => {
      const silent = text === SILENT_REPLY_TOKEN;
      const attempt = createAttempt();
      const input = finalizationInput(attempt, {
        trigger: "user",
        sourceReplyDeliveryMode: "automatic",
      });
      backendMocks.finalize.mockResolvedValue(finalizationReply("empty", text));
      const result = await finalize(input);
      expect(backendMocks.finalize).toHaveBeenCalledTimes(silent ? 1 : 2);
      expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
      if (!errorText) {
        expect(result.finalizationOutcome).toBe("answered");
        expect(result.attempt.assistantTexts).toEqual([]);
        expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
      } else {
        expect(result.finalizationOutcome).toBe("failed");
        expect(result.attempt).toBe(attempt);
        expect(result.terminalState).toBe(input.initial.terminalState);
        expectPayload(result, {
          isError: true,
          text: expect.stringContaining(errorText),
        });
        if (attempt.lastToolError) {
          expect(result.prepared.attemptToolSummary).toMatchObject({
            failures: 1,
            unresolvedError: { toolName: "exec" },
          });
        }
      }
      expect(transcriptMocks.append).not.toHaveBeenCalled();
    },
  );

  it("does not accept authored silence after an original timeout", async () => {
    const attempt = providerFailure();
    attempt.terminal = { kind: "timeout", phase: "prompt", source: "idle" };
    const input = finalizationInput(attempt, {
      trigger: "user",
      sourceReplyDeliveryMode: "automatic",
    });
    backendMocks.finalize.mockResolvedValue(finalizationReply("empty", SILENT_REPLY_TOKEN));

    const result = await finalize(input);

    expect(backendMocks.finalize).toHaveBeenCalledTimes(2);
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(isEmbeddedRunTerminalTimeout(result.terminalState.outcome)).toBe(true);
    expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
    expect(result.prepared.timedOutDuringPrompt).toBe(true);
    expect(transcriptMocks.append).not.toHaveBeenCalled();
  });

  it.each([
    { trigger: "user", expectation: "required" },
    { trigger: "cron", expectation: "optional" },
    { trigger: "user", expectation: "result-required" },
  ] as const)(
    "settles empty $trigger/$expectation turns without persisting a synthetic answer",
    async ({ trigger, expectation }) => {
      const attempt = settledAttempt(false);
      const emptyAssistant = textAssistant("");
      backendMocks.finalize.mockResolvedValue(
        finalizationReply("empty", undefined, {
          assistant: emptyAssistant,
          usage: emptyAssistant.usage,
        }),
      );
      const input = finalizationInput(attempt, {
        trigger,
        sourceReplyDeliveryMode: "automatic",
        terminalReplyExpectation: expectation,
      });

      const result = await finalize(input);

      expect(backendMocks.finalize).toHaveBeenCalledTimes(expectation === "optional" ? 0 : 2);
      expect(result.finalizationOutcome).toBe(
        expectation === "optional" ? "not-attempted" : "failed",
      );
      expect(result.prepared.payloadsWithToolMedia ?? []).toEqual([]);
      expect(transcriptMocks.append).not.toHaveBeenCalled();
      expect(result.attempt.assistantTexts).toEqual([]);
      if (expectation === "required") {
        const terminal = await resolveEmbeddedRunTerminal(
          makeTerminalInput({
            ...result.prepared,
            attempt: result.attempt,
            attemptAssistant: result.attemptAssistant,
            terminalState: result.terminalState,
            runParams: input.terminalBase.runParams,
            settledTurnFinalizationOutcome: result.finalizationOutcome,
            replayState: { hadPotentialSideEffects: true, replayInvalid: false },
          }),
        );
        assert(terminal.action === "complete", "Expected completed failure");
        expect(getReplyPayloadMetadata(terminal.result.payloads?.[0] ?? {})).toMatchObject({
          assistantTranscriptOwned: true,
        });
      }
    },
  );

  it("closes failed finalizer controls while retaining the original failure", async () => {
    vi.useFakeTimers();
    const attempt = settledAttempt();
    const input = finalizationInput(attempt);
    backendMocks.finalize.mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
      params.onAttemptTimeout?.(new Error("finalizer timeout"));
      throw new Error("finalizer failed");
    });

    const result = await finalize(input);
    await vi.advanceTimersByTimeAsync(EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS + 1);

    expect(input.finalization.abortSignal.aborted).toBe(false);
    expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
    expect(backendMocks.finalize).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expectPayload(result, { text: expect.stringContaining("failed"), isError: true });
    expect(result.prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "post-processing error",
      fatalForCron: true,
    });
    expect(result.attempt.assistantTexts).toEqual([]);
  });

  it.each(["failed", "stop", "length"] as const)(
    "does not replace %s terminal ownership when cancellation arrives during delivery observation",
    async (source) => {
      const input = finalizationInput(source === "failed" ? undefined : cutOffAttempt(source));
      const controller = new AbortController();
      input.finalization.abortSignal = AbortSignal.any([
        input.finalization.abortSignal,
        controller.signal,
      ]);
      let observations = 0;
      input.terminalBase.runParams.resolveReplyDelivery = async () => {
        if (++observations === 2) {
          controller.abort(new Error("cancelled before acceptance"));
        }
        return "missing";
      };
      const text = "The completed tools produced a result.";
      backendMocks.finalize.mockResolvedValueOnce(finalizationReply("answered", text));
      await expect(finalize(input)).rejects.toThrow();
      expect(observations).toBe(2);
      expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
    },
  );

  it.each(["outer", "Stop"])(
    "preserves %s cancellation during finalization without a fallback",
    async (source) => {
      const attempt = settledAttempt();
      const input = finalizationInput(attempt);
      const controller = new AbortController();
      input.finalization.abortSignal = AbortSignal.any([
        input.finalization.abortSignal,
        controller.signal,
      ]);
      backendMocks.finalize.mockImplementationOnce(async (params: EmbeddedRunAttemptParams) => {
        if (source === "outer") {
          controller.abort(new Error("cancelled by user"));
        } else {
          params.onAttemptAbort?.();
        }
        params.abortSignal?.throwIfAborted();
        throw new Error("finalizer cancellation did not propagate");
      });

      const result = await finalize(input);

      expect(backendMocks.finalize).toHaveBeenCalledOnce();
      expect(input.finalization.abortSignal.aborted).toBe(true);
      expect(input.terminalBase.runParams.onAttemptTerminalReplaced).not.toHaveBeenCalled();
      expect(result.finalizationOutcome).toBe("failed");
      expect(result.attempt).toBe(attempt);
      expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
      expect(transcriptMocks.append).not.toHaveBeenCalled();
    },
  );
});
