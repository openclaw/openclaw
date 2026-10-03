import {
  emitAgentEvent,
  normalizeUsage,
  onAgentEvent as onGlobalAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  THREAD_ID,
  TURN_ID,
  createProjector,
  buildEmptyToolTelemetry,
  createParams,
  readAttemptTerminal,
  expectUsageLimitPromptError,
  forCurrentTurn,
  agentMessageDelta,
  appServerError,
  rateLimitsUpdated,
  turnCompleted,
  turnWithStatus,
  pendingCommandStarted,
  vi,
  expectUsageFields,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector terminal errors", () => {
  type Projector = Awaited<ReturnType<typeof createProjector>>;

  function terminalError(
    error: Record<string, unknown>,
    method: "error" | "turn/completed" = "error",
  ) {
    return forCurrentTurn(
      method,
      method === "error"
        ? { error, willRetry: false }
        : { turn: { id: TURN_ID, status: "failed", items: [], error } },
    );
  }
  const compaction = (phase: "started" | "completed", id: string) =>
    forCurrentTurn(`item/${phase}`, { item: { type: "contextCompaction", id } });
  const snapshot = (projector: Projector) => projector.buildResult(buildEmptyToolTelemetry());
  const refusalDetails = (projector: Projector) =>
    snapshot(projector).currentAttemptAssistant?.diagnostics?.[0]?.details;
  const review = (projector: Projector) => refusalDetails(projector)?.review;
  const compactionEvents = (callback: ReturnType<typeof vi.fn>) =>
    callback.mock.calls.map(([event]) => event).filter((event) => event.stream === "compaction");
  function compactionEvent(phase: "start" | "end", itemId: string, completed?: boolean) {
    return {
      stream: "compaction",
      data: {
        phase,
        backend: "codex-app-server",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId,
        ...(completed === undefined ? {} : { completed }),
      },
    };
  }
  async function compactionFixture() {
    const onAgentEvent = vi.fn();
    const onContextCompacted = vi.fn();
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { onContextCompacted },
    );
    return { projector, onAgentEvent, onContextCompacted };
  }
  async function misalignmentProjector(
    detailedExplanation: string | undefined,
    steer: { message: string } | undefined,
  ) {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("error", {
        error: {
          message: "The provider paused this request.",
          codexErrorInfo: "misalignmentPolicyViolation",
          misalignment: { detailedExplanation, ...(steer ? { steer } : {}) },
        },
        willRetry: false,
      }),
    );
    return projector;
  }

  it.each([
    { codexErrorInfo: "rateLimitExceeded", status: 429 },
    { codexErrorInfo: "serverOverloaded", status: 503, code: "OVERLOADED" },
    { codexErrorInfo: "internalServerError", status: 500 },
    { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } }, status: 503 },
  ])(
    "preserves terminal provider facts for $codexErrorInfo",
    async ({ codexErrorInfo, ...facts }) => {
      for (const method of ["error", "turn/completed"] as const) {
        const projector = await createProjector();
        const error = { message: "The model is not available.", codexErrorInfo };
        await projector.handleNotification(terminalError(error, method));
        const terminal = readAttemptTerminal(snapshot(projector));
        expect(terminal.promptError).toBeInstanceOf(Error);
        expect(terminal.promptError).toMatchObject({ message: error.message, ...facts });
        expect(projector.settledTurnFailureFinalizationAllowed).toBe(
          codexErrorInfo === "serverOverloaded",
        );
      }
    },
  );

  it("keeps missing tool detail without overriding an explicit abort", async () => {
    const projector = await createProjector();
    projector.markAborted();
    await projector.handleNotification(pendingCommandStarted("cmd-aborted"));
    await projector.handleNotification(turnWithStatus("interrupted"));
    const result = snapshot(projector);
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: true,
      promptError: null,
      promptErrorSource: null,
    });
    expect(result.lastToolError).toMatchObject({
      toolName: "bash",
      error: expect.stringContaining("without a matching tool.result"),
    });
  });

  it("fails closed when interrupted status has no abort marker", async () => {
    const projector = await createProjector();
    await projector.handleNotification(pendingCommandStarted("cmd-interrupted"));
    await projector.handleNotification(turnWithStatus("interrupted"));
    const result = snapshot(projector);
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptErrorSource: "prompt",
    });
    expect(readAttemptTerminal(result).promptError).toContain("without a matching tool.result");
    expect(result.lastToolError).toBeUndefined();
  });

  it("does not fail a completed reply after a retryable app-server error notification", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(agentMessageDelta("still working"));
    await projector.handleNotification(
      appServerError({
        message: "Rate limit reached",
        willRetry: true,
        codexErrorInfo: "rateLimitExceeded",
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "final answer" }]),
    );
    const result = snapshot(projector);
    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: null,
      promptErrorSource: null,
    });
    expect(result.lastAssistant?.stopReason).toBe("stop");
    expect(result.lastAssistant?.errorMessage).toBeUndefined();
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: { phase: "retrying", message: "Rate limited. The provider is retrying." },
      }),
    );
  });

  it.each([
    {
      label: "biological-risk",
      message: "This content was flagged for possible biological risk. Try rephrasing it.",
      codexErrorInfo: "other",
      category: "bio",
      completionOnly: true,
    },
    {
      label: "typed cyber",
      message: "This request was blocked by the provider's cyber policy.",
      codexErrorInfo: "cyberPolicy",
      category: "cyber",
      completionOnly: false,
    },
  ])(
    "keeps $label refusals terminal (completion only: $completionOnly)",
    async ({ message, codexErrorInfo, category, completionOnly }) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...(await createParams()), onAgentEvent });
      const error = { message, codexErrorInfo };

      if (!completionOnly) {
        await projector.handleNotification(appServerError({ ...error, willRetry: false }));
      }
      await projector.handleNotification(terminalError(error, "turn/completed"));

      const result = snapshot(projector);
      const terminalAssistant = result.currentAttemptAssistant;

      expect(readAttemptTerminal(result)).toMatchObject({
        promptError: null,
        promptErrorSource: null,
      });
      expect(terminalAssistant).toMatchObject({
        stopReason: "error",
        errorMessage: message,
        diagnostics: [
          {
            type: "provider_refusal",
            details: { provider: "openai", category },
          },
        ],
      });
      expect(result.lastAssistant).toBe(terminalAssistant);
      expect(projector.settledTurnFailureFinalizationAllowed).toBe(false);
      const policyNotices = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "notice" && event.data.phase === "provider_policy");
      expect(policyNotices).toEqual(
        category === "cyber"
          ? [
              {
                stream: "notice",
                data: {
                  phase: "provider_policy",
                  category: "cyber",
                  state: "blocked",
                  provider: "openai",
                  model: "gpt-5.4-codex",
                },
              },
            ]
          : [],
      );
      expect(
        result.messagesSnapshot.filter(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.diagnostics?.some((diagnostic) => diagnostic.type === "provider_refusal"),
        ),
      ).toHaveLength(1);
    },
  );

  it("upgrades same-turn misalignment findings at exact UTF-8 limits without borrowing another turn's continuation", async () => {
    const projector = await createProjector();
    const error = {
      message: "The provider paused this request.",
      codexErrorInfo: "misalignmentPolicyViolation",
    };
    await projector.handleNotification(forCurrentTurn("error", { error, willRetry: false }));
    const details = {
      errorType: "future_category",
      detailedExplanation: "🙂".repeat(16_384),
      steer: { message: ` ${"🙂".repeat(255)}   ` },
    };
    await projector.handleNotification({
      method: "error",
      params: {
        threadId: THREAD_ID,
        turnId: "unrelated-turn",
        error: { ...error, misalignment: details },
        willRetry: false,
      },
    });
    expect(refusalDetails(projector)).not.toHaveProperty("review");
    await projector.handleNotification(
      terminalError({ ...error, misalignment: details }, "turn/completed"),
    );
    expect(snapshot(projector).currentAttemptAssistant?.diagnostics?.[0]).toMatchObject({
      type: "provider_refusal",
      details: {
        provider: "openai",
        category: "misalignment",
        nativeThreadId: THREAD_ID,
        nativeTurnId: TURN_ID,
        review: {
          explanation: details.detailedExplanation,
          continuation: details.steer,
          errorType: details.errorType,
        },
      },
    });
  });

  it.each([
    { label: "missing", explanation: undefined },
    { label: "blank", explanation: " \n " },
    { label: "too many UTF-8 bytes", explanation: "🙂".repeat(16_385) },
  ])("does not offer review for $label native explanation", async ({ explanation }) => {
    const projector = await misalignmentProjector(explanation, {
      message: "Continue only the requested task.",
    });
    expect(review(projector)).toBeUndefined();
  });

  it.each([
    { label: "missing", steer: undefined },
    { label: "blank", steer: { message: " \n " } },
    { label: "too many UTF-8 bytes", steer: { message: "🙂".repeat(257) } },
  ])("keeps $label continuation findings non-continuable", async ({ steer }) => {
    const explanation = "Review the proposed action before proceeding.";
    const projector = await misalignmentProjector(explanation, steer);
    expect(review(projector)).toEqual({ explanation });
  });

  it("keeps an active native compaction failure scoped through the failed turn", async () => {
    const { projector, onAgentEvent, onContextCompacted } = await compactionFixture();
    await projector.handleNotification(compaction("started", "compact-failed"));
    await projector.handleNotification(
      appServerError({
        message: "remote compaction failed",
        willRetry: false,
        codexErrorInfo: "other",
      }),
    );
    expect(readAttemptTerminal(snapshot(projector))).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(true);
    await projector.handleNotification(
      terminalError(
        { message: "remote compaction failed", codexErrorInfo: "other" },
        "turn/completed",
      ),
    );
    const result = snapshot(projector);
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(true);
    expect(projector.isCompacting()).toBe(false);
    expect(result.itemLifecycle).toEqual({ startedCount: 1, completedCount: 0, activeCount: 0 });
    expect(result.compactionCount).toBeUndefined();
    expect(onContextCompacted).not.toHaveBeenCalled();
    expect(compactionEvents(onAgentEvent)).toEqual([
      compactionEvent("start", "compact-failed"),
      compactionEvent("end", "compact-failed", false),
    ]);
  });

  it("closes visible unfinished compaction once without forgetting native work", async () => {
    const { projector, onAgentEvent, onContextCompacted } = await compactionFixture();
    await projector.handleNotification(compaction("started", "compact-unfinished"));
    expect(onAgentEvent).toHaveBeenCalledWith(compactionEvent("start", "compact-unfinished"));
    await projector.closeProjection();
    await projector.closeProjection();
    const result = snapshot(projector);
    expect(projector.isCompacting()).toBe(false);
    expect(result.itemLifecycle).toEqual({ startedCount: 1, completedCount: 0, activeCount: 0 });
    expect(result.compactionCount).toBeUndefined();
    expect(onContextCompacted).not.toHaveBeenCalled();
    expect(compactionEvents(onAgentEvent)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ phase: "start", itemId: "compact-unfinished" }),
      }),
      compactionEvent("end", "compact-unfinished", false),
    ]);
  });

  it("preserves observed native completion when closing progress with a pending observer", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const onAgentEvent = vi.fn();
    const onContextCompacted = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent },
      { onContextCompacted },
    );
    await projector.handleNotification(compaction("started", "compact-observer-pending"));
    const completion = projector.handleNotification(
      compaction("completed", "compact-observer-pending"),
    );
    const expectedEvents = [
      compactionEvent("start", "compact-observer-pending"),
      compactionEvent("end", "compact-observer-pending", true),
    ];
    try {
      await entered.promise;
      await projector.closeProjection();
      await projector.closeProjection();
      expect(snapshot(projector)).toMatchObject({
        compactionCount: 1,
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      });
      expect(compactionEvents(onAgentEvent)).toEqual(expectedEvents);
    } finally {
      release.resolve();
      await completion;
    }
    expect(onContextCompacted).toHaveBeenCalledOnce();
    expect(compactionEvents(onAgentEvent)).toEqual(expectedEvents);
  });

  it("keeps other errors prompt-scoped after native compaction completes", async () => {
    const { projector, onAgentEvent, onContextCompacted } = await compactionFixture();
    await projector.handleNotification(compaction("started", "compact-completed"));
    await projector.handleNotification(compaction("completed", "compact-completed"));
    await projector.handleNotification(
      appServerError({
        message: "unrelated provider failure",
        willRetry: false,
        codexErrorInfo: "other",
      }),
    );
    expect(readAttemptTerminal(snapshot(projector))).toMatchObject({
      promptError: "unrelated provider failure",
      promptErrorSource: "prompt",
    });
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(false);
    await projector.handleNotification(compaction("completed", "compact-completed"));
    await projector.handleNotification(turnWithStatus("interrupted"));
    await projector.closeProjection();
    expect(snapshot(projector).compactionCount).toBe(1);
    expect(onContextCompacted).toHaveBeenCalledOnce();
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "compaction" && event.data.phase === "end"),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ itemId: "compact-completed", completed: true }),
      }),
    ]);
  });

  it("uses a recent Codex rate-limit snapshot when failed turns omit reset details", async () => {
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    const projector = await createProjector(undefined, {
      readRecentRateLimits: () => rateLimitsUpdated(resetsAt).params,
    });
    await projector.handleNotification(
      terminalError(
        {
          message: "You've reached your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        "turn/completed",
      ),
    );
    const result = snapshot(projector);

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Next reset in");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
  });

  it("preserves Codex retry hints when failed turns omit structured reset details", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      terminalError(
        {
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 9:00 AM.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        "turn/completed",
      ),
    );
    const result = snapshot(projector);

    const promptError = expectUsageLimitPromptError(readAttemptTerminal(result).promptError);
    expect(promptError.message).toContain("You've reached your Codex subscription usage limit.");
    expect(promptError.message).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(promptError.message).not.toContain("Codex did not return a reset time");
    expect(readAttemptTerminal(result).promptErrorSource).toBe("prompt");
  });
});

describe("CodexAppServerEventProjector usage projection", () => {
  type Projector = Awaited<ReturnType<typeof createProjector>>;
  const nativeCounts = { inputTokens: 5, cachedInputTokens: 2, outputTokens: 7 };
  const usage = { ...nativeCounts, totalTokens: 12, reasoningOutputTokens: 0 };
  const counts = { input: 3, output: 7, cacheRead: 2, total: 12 };
  const cumulative = {
    totalTokens: 1_000_000,
    inputTokens: 999_000,
    cachedInputTokens: 500,
    outputTokens: 500,
  };
  const unavailable = { state: "unavailable" };
  const result = (projector: Projector) => projector.buildResult(buildEmptyToolTelemetry());
  const response = (responseId: string, value: Record<string, unknown> | null) =>
    forCurrentTurn("rawResponse/completed", { responseId, usage: value });
  const thread = (last: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    forCurrentTurn("thread/tokenUsage/updated", { tokenUsage: { last, ...extra } });
  const retry = () => forCurrentTurn("error", { error: { message: "retry" }, willRetry: true });

  it("replaces the resolved window with native context and prompt-token snapshots", async () => {
    const callback = vi.fn();
    const projector = await createProjector(
      { ...(await createParams()), onAgentEvent: callback },
      { initialContextTokens: 1_050_000 },
    );
    expect(result(projector)).toMatchObject({
      contextTokens: 1_050_000,
      contextTokensSource: "resolved",
    });
    await projector.handleNotification(
      thread(
        {
          totalTokens: 300_010,
          inputTokens: 300_000,
          cachedInputTokens: 250_000,
          cacheWriteInputTokens: 5_000,
          outputTokens: 10,
          reasoningOutputTokens: 4,
        },
        { modelContextWindow: 875_900 },
      ),
    );
    expect(callback).toHaveBeenCalledWith({
      stream: "usage",
      data: {
        activeContextTokens: 300_010,
        cachedInputTokens: 250_000,
        cacheWriteInputTokens: 5_000,
        inputTokens: 300_000,
        modelContextWindow: 875_900,
        promptTokens: 300_000,
        reasoningOutputTokens: 4,
      },
    });
    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(turnCompleted());
    expect(result(projector)).toMatchObject({
      contextTokens: 875_900,
      contextTokensSource: "runtime",
    });
  });

  it("publishes each completed response once before tools settle and carries totals across native turns", async () => {
    const params = await createParams();
    const callback = vi.fn();
    const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];
    const createBoundProjector = async (attempt: typeof params) => {
      const host = await createAdmittedHostCapabilityTestFixture(attempt);
      hosts.push(host);
      return {
        host,
        projector: await createProjector({ ...attempt, hostCapabilities: host.hostCapabilities }),
      };
    };
    const observed: number[] = [];
    const unsubscribe = onGlobalAgentEvent((event) => {
      if (event.stream === "lifecycle") {
        params.lifecycleGeneration = event.lifecycleGeneration;
      }
      if (event.stream === "usage" && typeof event.data.outputTokens === "number") {
        observed.push(event.data.outputTokens);
      }
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1 },
    });
    params.onAgentEvent = callback;
    const { host: runHost, projector } = await createBoundProjector(params);
    const completedResponse = (id: string, outputTokens: number) =>
      response(id, {
        ...usage,
        cacheWriteInputTokens: 1,
        outputTokens,
        totalTokens: 5 + outputTokens,
        reasoningOutputTokens: 3,
      });
    try {
      await projector.handleNotification(completedResponse("response-1", 100));
      expect(observed).toEqual([100]);
      await projector.handleNotification(completedResponse("response-2", 20));
      await projector.handleNotification(completedResponse("response-1", 100));
      await projector.handleNotification(retry());
      expect(result(projector).attemptUsage).toMatchObject({
        input: 4,
        output: 120,
        cacheRead: 4,
        cacheWrite: 2,
        reasoningTokens: 6,
        total: 130,
        contextUsage: unavailable,
      });
      await projector.handleNotification(completedResponse("response-3", 50));
      await projector.handleNotification(completedResponse("response-1", 100));
      await projector.handleNotification(
        thread({ inputTokens: 5, outputTokens: 50, totalTokens: 55 }),
      );
      expect(observed).toEqual([100, 120, 170]);
      await projector.handleNotification(agentMessageDelta("done"));
      await projector.handleNotification(turnCompleted());
      const expected = {
        input: 6,
        output: 170,
        cacheRead: 6,
        cacheWrite: 3,
        reasoningTokens: 9,
        total: 185,
        contextUsage: { state: "available", promptTokens: 5, totalTokens: 55 },
      };
      expect(result(projector).attemptUsage).toMatchObject(expected);
      expect(normalizeUsage(result(projector).lastAssistant?.usage)).toMatchObject(expected);
      const nextAttempt = await createProjector({
        ...params,
        hostCapabilities: runHost.hostCapabilities,
      });
      await nextAttempt.handleNotification(completedResponse("response-4", 10));
      expect(observed).toEqual([100, 120, 170, 180]);
      const nextCounts = { input: 2, output: 10, cacheRead: 2, cacheWrite: 1, total: 15 };
      const nextUsage = { ...nextCounts, reasoningTokens: 3 };
      expect(result(nextAttempt).attemptUsage).toMatchObject(nextUsage);
      nextAttempt.markAborted();
      expect(result(nextAttempt).attemptUsage).toMatchObject({
        ...nextUsage,
        contextUsage: unavailable,
      });
      const { projector: otherRun } = await createBoundProjector({
        ...params,
        runId: "another-run",
      });
      await otherRun.handleNotification(completedResponse("another-response", 7));
      expect(observed).toEqual([100, 120, 170, 180, 7]);
      expect(
        callback.mock.calls
          .map(([event]) => event)
          .filter(
            (event) => event.stream === "usage" && typeof event.data.outputTokens === "number",
          )
          .map((event) => event.data.outputTokens),
      ).toEqual(observed);
    } finally {
      unsubscribe();
      for (const host of hosts) {
        host.closeHost();
        host.closeAdmission();
      }
    }
  });

  it("marks native telemetry constrained by an authored context cap", async () => {
    const projector = await createProjector({
      ...(await createParams()),
      authoredContextTokenCap: 272_000,
    });
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", { tokenUsage: { modelContextWindow: 272_000 } }),
    );
    expect(result(projector)).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "runtime-configured",
    });
  });

  it("retains current-turn thread counts through retry, refresh, and abort without raw responses", async () => {
    const projector = await createProjector();
    const assertUsage = (
      expected: typeof counts & { cacheWrite: number },
      context: Record<string, unknown>,
      reasoning: number,
    ) => {
      const snapshot = result(projector);
      expect(snapshot.assistantTexts).toEqual(["done"]);
      expect(snapshot.modelIterations).toBeUndefined();
      expectUsageFields(snapshot.attemptUsage, expected);
      expect(snapshot.attemptUsage?.reasoningTokens).toBe(reasoning);
      expect(snapshot.attemptUsage?.contextUsage).toEqual(context);
      expectUsageFields(snapshot.lastAssistant?.usage, expected);
      expect(snapshot.lastAssistant?.usage.contextUsage).toEqual(context);
      expect(normalizeUsage(snapshot.lastAssistant?.usage)?.reasoningTokens).toBe(reasoning);
    };
    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      thread(
        { ...usage, cacheWriteInputTokens: 1, reasoningOutputTokens: 3 },
        { total: cumulative },
      ),
    );
    const initial = { input: 2, output: 7, cacheRead: 2, cacheWrite: 1, total: 12 };
    assertUsage(initial, { state: "available", promptTokens: 5, totalTokens: 12 }, 3);
    await projector.handleNotification(retry());
    assertUsage(initial, unavailable, 3);
    await projector.handleNotification(
      thread({
        ...usage,
        totalTokens: 21,
        inputTokens: 14,
        cachedInputTokens: 8,
        cacheWriteInputTokens: 2,
        reasoningOutputTokens: 4,
      }),
    );
    const updated = { input: 4, output: 7, cacheRead: 8, cacheWrite: 2, total: 21 };
    assertUsage(updated, { state: "available", promptTokens: 14, totalTokens: 21 }, 4);
    projector.markAborted();
    assertUsage(updated, unavailable, 4);
  });

  it.each([
    { label: "incomplete", value: { totalTokens: 12 }, expected: { total: 12 } },
    {
      label: "incoherent total",
      value: { ...usage, totalTokens: 6 },
      expected: { ...counts, cacheWrite: 0, total: 6 },
    },
    {
      label: "impossible cache counts",
      value: { ...usage, cachedInputTokens: 4, cacheWriteInputTokens: 2 },
      expected: { output: 7, cacheRead: 4, cacheWrite: 2, total: 12 },
    },
  ])("keeps valid fields from $label response usage", async ({ label, value, expected }) => {
    const projector = await createProjector();
    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(response("response-1", value));
    const snapshot = result(projector);
    expect(snapshot.assistantTexts).toEqual(["done"]);
    expect(snapshot.attemptUsage).toMatchObject(expected);
    if (label === "incomplete") {
      expect(snapshot.attemptUsage?.input).toBeUndefined();
      expect(snapshot.attemptUsage?.output).toBeUndefined();
      expect(snapshot.attemptUsage?.cacheRead).toBeUndefined();
      expect(snapshot.attemptUsage?.reasoningTokens).toBeUndefined();
    }
    expect(snapshot.attemptUsage?.contextUsage).toEqual(unavailable);
    expect(snapshot.lastAssistant?.usage.contextUsage).toEqual(unavailable);
  });

  it("counts unique responses with no usage without reviving thread billing", async () => {
    const projector = await createProjector();
    await projector.handleNotification(thread(usage));
    for (const id of ["response-1", "response-1", "response-2"]) {
      await projector.handleNotification(response(id, null));
    }
    expect(result(projector).modelIterations).toBe(2);
    expect(result(projector).attemptUsage).toEqual({ contextUsage: unavailable });
  });

  it("keeps exact counts over cumulative thread usage and missing or replayed final response usage", async () => {
    const projector = await createProjector();
    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(response("response-1", usage));
    await projector.handleNotification(
      thread(
        { totalTokens: 1_000, inputTokens: 900, cachedInputTokens: 100, outputTokens: 100 },
        { total: cumulative },
      ),
    );
    expect(result(projector).assistantTexts).toEqual(["done"]);
    expectUsageFields(result(projector).attemptUsage, counts);
    expect(result(projector).attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    await projector.handleNotification(response("response-2", null));
    await projector.handleNotification(response("response-2", null));
    const snapshot = result(projector);
    expect(snapshot.modelIterations).toBe(2);
    expectUsageFields(snapshot.attemptUsage, counts);
    expect(snapshot.attemptUsage?.contextUsage).toEqual(unavailable);
    expectUsageFields(snapshot.lastAssistant?.usage, counts);
    expect(snapshot.lastAssistant?.usage.contextUsage).toEqual(unavailable);
  });

  it("preserves observed usage but invalidates context when the turn is interrupted", async () => {
    const projector = await createProjector();
    await projector.handleNotification(response("response-1", usage));
    await projector.handleNotification(turnWithStatus("interrupted"));
    expect(result(projector).attemptUsage).toMatchObject({ ...counts, contextUsage: unavailable });
  });

  it("retains output and token counts but invalidates exact context usage on timeout", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "msg-1", text: "done" },
      }),
    );
    await projector.handleNotification(thread(usage));
    await projector.handleNotification(response("response-1", usage));
    projector.markTimedOut();
    const timedOut = result(projector);
    expect(readAttemptTerminal(timedOut).aborted).toBe(true);
    expect(timedOut.attemptUsage?.contextUsage).toEqual(unavailable);
    expect(timedOut.assistantTexts).toEqual(["done"]);
    expectUsageFields(timedOut.attemptUsage, counts);
  });
});
