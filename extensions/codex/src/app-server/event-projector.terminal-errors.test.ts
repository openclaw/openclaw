import {
  emitAgentEvent,
  normalizeUsage,
  onAgentEvent as onGlobalAgentEvent,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as fixture from "./event-projector.compact.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  THREAD_ID,
  TURN_ID,
  createProjector,
  createParams,
  readAttemptTerminal,
  expectUsageLimitPromptError,
  forCurrentTurn,
  appServerError,
  rateLimitsUpdated,
  turnWithStatus,
  pendingCommandStarted,
  vi,
  expectUsageFields,
} from "./event-projector.test-harness.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector terminal errors", () => {
  type Projector = Awaited<ReturnType<typeof createProjector>>;
  function fail(projector: Projector, error: Record<string, unknown>, completed = false) {
    return fixture.notify(
      projector,
      completed ? "turn/completed" : "error",
      completed
        ? { turn: { id: TURN_ID, status: "failed", items: [], error } }
        : { error, willRetry: false },
    );
  }
  function expectTerminal(
    result: ReturnType<typeof fixture.result>,
    promptError: unknown,
    promptErrorSource: unknown,
  ) {
    expect(readAttemptTerminal(result)).toMatchObject({
      promptError,
      promptErrorSource,
    });
  }
  const compaction = (projector: Projector, phase: "started" | "completed", id: string) =>
    fixture.notify(projector, `item/${phase}`, { item: { type: "contextCompaction", id } });
  const refusalDetails = (projector: Projector) =>
    fixture.result(projector).currentAttemptAssistant?.diagnostics?.[0]?.details;
  const review = (projector: Projector) => refusalDetails(projector)?.review;
  const compactionEvents = (callback: Parameters<typeof fixture.events>[0]) =>
    fixture.events(callback, "compaction");
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
  async function compactionFixture(onContextCompacted = vi.fn()) {
    return { ...(await fixture.observe({}, { onContextCompacted })), onContextCompacted };
  }
  async function misalignmentProjector(
    detailedExplanation: string | undefined,
    steer: { message: string } | undefined,
  ) {
    const projector = await createProjector();
    await fixture.notify(projector, "error", {
      error: {
        message: "The provider paused this request.",
        codexErrorInfo: "misalignmentPolicyViolation",
        misalignment: { detailedExplanation, ...(steer ? { steer } : {}) },
      },
      willRetry: false,
    });
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
      for (const completed of [false, true]) {
        const projector = await createProjector();
        const error = { message: "The model is not available.", codexErrorInfo };
        await fail(projector, error, completed);
        const terminal = readAttemptTerminal(fixture.result(projector));
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
    const result = fixture.result(projector);
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

  it("does not fail a completed reply after a retryable app-server error notification", async () => {
    const { projector, onAgentEvent } = await fixture.observe();
    await fixture.delta(projector, "still working");
    await projector.handleNotification(
      appServerError({
        message: "Rate limit reached",
        willRetry: true,
        codexErrorInfo: "rateLimitExceeded",
      }),
    );
    await fixture.finish(projector, [fixture.message("msg-1", "final answer")]);
    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual(["final answer"]);
    expectTerminal(result, null, null);
    expect(result.lastAssistant).toMatchObject({ stopReason: "stop", errorMessage: undefined });
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "run_status",
        data: { phase: "retrying", message: "Rate limited. The provider is retrying." },
      }),
    );
  });

  it.each([
    {
      message: "This content was flagged for possible biological risk. Try rephrasing it.",
      codexErrorInfo: "other",
      category: "bio",
    },
    {
      message: "This request was blocked by the provider's cyber policy.",
      codexErrorInfo: "cyberPolicy",
      category: "cyber",
    },
  ])("keeps $category refusals terminal", async ({ message, codexErrorInfo, category }) => {
    const { projector, onAgentEvent } = await fixture.observe();
    const error = { message, codexErrorInfo };
    if (category === "cyber") {
      await projector.handleNotification(appServerError({ ...error, willRetry: false }));
    }
    await fail(projector, error, true);
    const result = fixture.result(projector);
    const terminalAssistant = result.currentAttemptAssistant;
    expectTerminal(result, null, null);
    expect(terminalAssistant).toMatchObject({
      stopReason: "error",
      errorMessage: message,
      diagnostics: [{ type: "provider_refusal", details: { provider: "openai", category } }],
    });
    expect(result.lastAssistant).toBe(terminalAssistant);
    expect(projector.settledTurnFailureFinalizationAllowed).toBe(false);
    const policyNotices = fixture
      .events(onAgentEvent, "notice")
      .filter((event) => event.data.phase === "provider_policy");
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
  });

  it("upgrades same-turn misalignment findings at exact UTF-8 limits without borrowing another turn's continuation", async () => {
    const projector = await createProjector();
    const error = {
      message: "The provider paused this request.",
      codexErrorInfo: "misalignmentPolicyViolation",
    };
    await fixture.notify(projector, "error", { error, willRetry: false });
    const details = {
      errorType: "future_category",
      detailedExplanation: "🙂".repeat(16_384),
      steer: { message: ` ${"🙂".repeat(255)}   ` },
    };
    await projector.handleNotification(
      prepareCodexServerNotification({
        method: "error",
        params: {
          threadId: THREAD_ID,
          turnId: "unrelated-turn",
          error: { ...error, misalignment: details },
          willRetry: false,
        },
      }),
    );
    expect(refusalDetails(projector)).not.toHaveProperty("review");
    await fail(projector, { ...error, misalignment: details }, true);
    expect(fixture.result(projector).currentAttemptAssistant?.diagnostics?.[0]).toMatchObject({
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

  it("does not offer review for too many UTF-8 bytes in a native explanation", async () => {
    const projector = await misalignmentProjector("🙂".repeat(16_385), {
      message: "Continue only the requested task.",
    });
    expect(review(projector)).toBeUndefined();
  });

  it("keeps missing continuation findings non-continuable", async () => {
    const explanation = "Review the proposed action before proceeding.";
    const projector = await misalignmentProjector(explanation, undefined);
    expect(review(projector)).toEqual({ explanation });
  });

  it.each([false, true])(
    "scopes errors to active compaction only (completed: %s)",
    async (completed) => {
      const { projector, onAgentEvent, onContextCompacted } = await compactionFixture();
      const id = "compact-1";
      const error = { message: "provider failure", codexErrorInfo: "other" };
      const source = completed ? "prompt" : "compaction";
      await compaction(projector, "started", id);
      if (completed) {
        await compaction(projector, "completed", id);
      }
      await fail(projector, error);
      expectTerminal(fixture.result(projector), error.message, source);
      expect(projector.settledTurnFailureFinalizationAllowed).toBe(!completed);
      if (completed) {
        await compaction(projector, "completed", id);
        await projector.handleNotification(turnWithStatus("interrupted"));
        await projector.closeProjection();
      } else {
        await fail(projector, error, true);
      }
      const result = fixture.result(projector);
      expectTerminal(result, error.message, source);
      expect(projector.settledTurnFailureFinalizationAllowed).toBe(!completed);
      expect(projector.isCompacting()).toBe(false);
      expect(result.itemLifecycle).toEqual({
        startedCount: 1,
        completedCount: Number(completed),
        activeCount: 0,
      });
      expect(result.compactionCount).toBe(completed ? 1 : undefined);
      expect(onContextCompacted).toHaveBeenCalledTimes(Number(completed));
      expect(compactionEvents(onAgentEvent)).toEqual([
        compactionEvent("start", id),
        compactionEvent("end", id, completed),
      ]);
    },
  );

  it("preserves observed native completion when closing progress with a pending observer", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const { projector, onAgentEvent, onContextCompacted } = await compactionFixture(
      vi.fn(async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    await compaction(projector, "started", "compact-observer-pending");
    const completion = compaction(projector, "completed", "compact-observer-pending");
    const expectedEvents = [
      compactionEvent("start", "compact-observer-pending"),
      compactionEvent("end", "compact-observer-pending", true),
    ];
    try {
      await entered.promise;
      await projector.closeProjection();
      await projector.closeProjection();
      expect(fixture.result(projector)).toMatchObject({
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

  it.each([false, true])(
    "preserves usage-limit reset details (recent snapshot: %s)",
    async (recent) => {
      const resetsAt = Math.ceil(Date.now() / 1000) + 120;
      const projector = await createProjector(
        undefined,
        recent
          ? {
              readRecentRateLimits: () => rateLimitsUpdated(resetsAt).params,
            }
          : undefined,
      );
      await fail(
        projector,
        {
          message: recent
            ? "You've reached your usage limit."
            : "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 9:00 AM.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        true,
      );
      const terminal = readAttemptTerminal(fixture.result(projector));
      const { message } = expectUsageLimitPromptError(terminal.promptError);
      expect(message).toContain("You've reached your Codex subscription usage limit.");
      expect(message).toContain(
        recent ? "Next reset in" : "Codex says to try again at May 11th, 2026 9:00 AM.",
      );
      if (!recent) {
        expect(message).not.toContain("Codex did not return a reset time");
      }
      expect(terminal.promptErrorSource).toBe("prompt");
    },
  );
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
  const result = (projector: Projector) => fixture.result(projector);
  const response = (responseId: string, value: Record<string, unknown> | null) =>
    forCurrentTurn("rawResponse/completed", { responseId, usage: value });
  const thread = (last: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    forCurrentTurn("thread/tokenUsage/updated", { tokenUsage: { last, ...extra } });
  const retry = () => forCurrentTurn("error", { error: { message: "retry" }, willRetry: true });
  const responseCounts = (responses: number, output: number) => ({
    input: 2 * responses,
    output,
    cacheRead: 2 * responses,
    cacheWrite: responses,
    reasoningTokens: 3 * responses,
    total: 5 * responses + output,
  });

  it("replaces the resolved window with native context and prompt-token snapshots", async () => {
    const { projector, onAgentEvent: callback } = await fixture.observe(
      {},
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
    await fixture.delta(projector, "done");
    await fixture.finish(projector);
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
        ...responseCounts(2, 120),
        contextUsage: unavailable,
      });
      await projector.handleNotification(completedResponse("response-3", 50));
      await projector.handleNotification(completedResponse("response-1", 100));
      await projector.handleNotification(
        thread({ inputTokens: 5, outputTokens: 50, totalTokens: 55 }),
      );
      expect(observed).toEqual([100, 120, 170]);
      await fixture.delta(projector, "done");
      await fixture.finish(projector);
      const expected = {
        ...responseCounts(3, 170),
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
      const nextUsage = responseCounts(1, 10);
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
        fixture
          .events(callback, "usage")
          .filter((event) => typeof event.data.outputTokens === "number")
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
    await fixture.notify(projector, "thread/tokenUsage/updated", {
      tokenUsage: { modelContextWindow: 272_000 },
    });
    expect(result(projector)).toMatchObject({
      contextTokens: 272_000,
      contextTokensSource: "runtime-configured",
    });
  });

  it("keeps exact counts over cumulative thread usage and missing or replayed final response usage", async () => {
    const projector = await createProjector();
    await fixture.delta(projector, "done");
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
});
