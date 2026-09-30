import {
  describe,
  embeddedAgentLog,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  THREAD_ID,
  TURN_ID,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  forCurrentTurn,
  findPlanEventWithSteps,
  turnCompleted,
  type ProjectorNotification,
  agentMessageDelta,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector reasoning and guardian projection", () => {
  async function observeProjector() {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    return {
      projector,
      onAgentEvent,
      async send(this: void, ...notifications: ProjectorNotification[]) {
        for (const notification of notifications) {
          await projector.handleNotification(notification);
        }
      },
      events(this: void, stream: string, phase?: string) {
        return onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === stream && (!phase || event.data.phase === phase))
          .map((event) => event.data);
      },
    };
  }

  function guardianWarning(message: string, threadId = THREAD_ID): ProjectorNotification {
    return { method: "guardianWarning", params: { threadId, message } } as ProjectorNotification;
  }

  function guardianReview(params: {
    id: string;
    status: string;
    target?: string | null;
    phase?: "started" | "completed";
    riskLevel?: string;
    userAuthorization?: string;
    rationale?: string | null;
    action?: Record<string, unknown>;
  }): ProjectorNotification {
    const phase = params.phase ?? "completed";
    return forCurrentTurn(`item/autoApprovalReview/${phase}`, {
      reviewId: params.id,
      targetItemId: params.target === undefined ? "cmd-1" : params.target,
      ...(phase === "completed" ? { decisionSource: "agent" } : {}),
      review: {
        status: params.status,
        ...(params.riskLevel ? { riskLevel: params.riskLevel } : {}),
        ...(params.userAuthorization ? { userAuthorization: params.userAuthorization } : {}),
        ...(params.rationale !== undefined ? { rationale: params.rationale } : {}),
      },
      action: params.action ?? {
        type: "execve",
        source: "shell",
        program: "/bin/printf",
        argv: ["printf", "hello"],
        cwd: "/tmp",
      },
    });
  }

  function commandItem(phase: "started" | "completed", id = "cmd-1"): ProjectorNotification {
    return forCurrentTurn(`item/${phase}`, {
      item: {
        type: "commandExecution",
        id,
        command: "printf hello",
        cwd: "/tmp",
        status: phase === "completed" ? "completed" : "inProgress",
        commandActions: [],
        ...(phase === "completed" ? { aggregatedOutput: "hello", exitCode: 0 } : {}),
      },
    });
  }

  it("preserves successful statusless native search results", async () => {
    const { send, events } = await observeProjector();
    const item = {
      id: "search-statusless",
      type: "webSearch",
      query: "sample",
      action: { type: "search", query: "sample" },
    };
    await send(
      forCurrentTurn("item/started", { item }),
      forCurrentTurn("item/completed", { item }),
    );
    expect(events("tool", "result")).toMatchObject([
      { isError: false, result: { status: "completed", query: "sample" } },
    ]);
    expect(events("item", "end")).toContainEqual(
      expect.objectContaining({ itemId: "tool:search-statusless", status: "completed" }),
    );
  });

  it("projects guardian review lifecycle details into agent events", async () => {
    const { send, events, projector } = await observeProjector();
    await send(
      commandItem("started"),
      guardianReview({ id: "review-1", status: "inProgress", phase: "started" }),
      forCurrentTurn("autoApprovalReview/strictReviewRequired", { startedAtMs: 1_787_273_600_000 }),
    );
    expect(events("codex_app_server.guardian", "strict_review_required")).toMatchObject([
      {
        method: "autoApprovalReview/strictReviewRequired",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        reviewId: "review-1",
        targetItemId: "cmd-1",
        command: "printf hello",
        startedAtMs: 1_787_273_600_000,
      },
    ]);
    await send(
      guardianWarning(
        "Automatic approval review approved (risk: low, authorization: high): Benign local probe.",
      ),
      guardianReview({
        id: "review-1",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Benign local probe.",
      }),
      commandItem("completed"),
    );
    expect(events("codex_app_server.guardian", "started")).toMatchObject([
      { reviewId: "review-1", targetItemId: "cmd-1", status: "inProgress" },
    ]);
    expect(events("codex_app_server.guardian", "completed")).toMatchObject([
      { reviewId: "review-1", targetItemId: "cmd-1", status: "approved", command: "printf hello" },
    ]);
    const reviews = events("tool", "review");
    expect(reviews.map((event) => event.review)).toEqual([
      { id: "review-1", label: "Guardian", status: "in_progress" },
      {
        id: "review-1",
        label: "Guardian",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Benign local probe.",
      },
    ]);
    expect(
      reviews.map((event) => [
        event.toolCallId,
        event.approvalReviewOutcome,
        event.hideFromChannelProgress,
      ]),
    ).toEqual([
      ["cmd-1", "reviewing", true],
      ["cmd-1", "approved", true],
    ]);
    const toolResult = projector
      .buildResult(buildEmptyToolTelemetry())
      .messagesSnapshot.find((message) => message.role === "toolResult");
    expect(requireRecord(toolResult, "reviewed tool result").details).toMatchObject({
      approvalReviews: [{ id: "review-1", status: "approved" }],
      approvalReviewOutcome: "approved",
    });
    expect(
      projector.buildResult(buildEmptyToolTelemetry()).didSendDeterministicApprovalPrompt,
    ).toBe(false);
  });

  it("correlates identical routine warnings with distinct command reviews", async () => {
    const { send, events } = await observeProjector();
    for (const [index, command] of ["printf first", "printf second"].entries()) {
      await send(
        guardianWarning(
          "Automatic approval review approved (risk: low, authorization: high): Safe command.",
        ),
        guardianReview({
          id: `review-${index + 1}`,
          target: `cmd-${index + 1}`,
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Safe command.",
          action: { type: "command", source: "shell", command, cwd: "/tmp" },
        }),
      );
    }
    expect(events("codex_app_server.guardian", "warning")).toEqual([]);
    expect(events("tool", "review").map((event) => event.review.id)).toEqual([
      "review-1",
      "review-2",
    ]);
  });

  it("flushes warnings at targetless, unrelated, and finalization boundaries", async () => {
    const { send, events, projector, onAgentEvent } = await observeProjector();
    const approved =
      "Automatic approval review approved (risk: low, authorization: high): Network call.";
    const denied =
      "Automatic approval review denied (risk: high, authorization: low): Unsafe command.";
    const timeout = "Automatic approval review timed out while evaluating the requested approval.";
    await send(guardianWarning(approved));
    expect(onAgentEvent).not.toHaveBeenCalled();
    await send(
      guardianReview({
        id: "review-network",
        target: null,
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Network call.",
        action: {
          type: "networkAccess",
          target: "https://example.invalid",
          host: "example.invalid",
          protocol: "https",
          port: 443,
        },
      }),
      guardianWarning(denied),
      forCurrentTurn("item/plan/delta", { itemId: "plan-1", delta: "continue" }),
      guardianWarning(timeout),
    );
    projector.buildResult(buildEmptyToolTelemetry());
    expect(events("codex_app_server.guardian", "completed")).toMatchObject([
      { reviewId: "review-network", targetItemId: null, command: "https://example.invalid" },
    ]);
    expect(events("codex_app_server.guardian", "warning").map((event) => event.message)).toEqual([
      approved,
      denied,
      timeout,
    ]);
    expect(events("tool", "review")).toEqual([]);
  });

  it.each([
    { firstStatus: "denied", liveOutcome: "denied", persistedOutcome: "denied" },
    { firstStatus: "inProgress", liveOutcome: "reviewing", persistedOutcome: "approved" },
  ])("bounds rows without losing a $liveOutcome aggregate", async (scenario) => {
    const { send, events, projector } = await observeProjector();
    await send(commandItem("started", "cmd-many-reviews"));
    for (let index = 0; index < 18; index += 1) {
      const status = index === 0 ? scenario.firstStatus : "approved";
      await send(
        guardianReview({
          id: `review-${index}`,
          target: "cmd-many-reviews",
          status,
          ...(status === "inProgress" ? { phase: "started" as const } : {}),
          riskLevel: status === "approved" ? "low" : "high",
          userAuthorization: status === "approved" ? "high" : "low",
          rationale: `${status} ${index}.`,
        }),
      );
    }
    expect(events("tool", "review").at(-1)?.approvalReviewOutcome).toBe(scenario.liveOutcome);
    await send(commandItem("completed", "cmd-many-reviews"));
    const toolResult = projector
      .buildResult(buildEmptyToolTelemetry())
      .messagesSnapshot.find((message) => message.role === "toolResult");
    expect(requireRecord(toolResult, "bounded review tool result").details).toMatchObject({
      approvalReviews: Array.from({ length: 16 }, (_, index) => ({ id: `review-${index + 2}` })),
      approvalReviewOutcome: scenario.persistedOutcome,
    });
    expect(events("tool", "result")[0]?.approvalReviewOutcome).toBe(scenario.persistedOutcome);
  });

  it.each([
    {
      status: "timedOut",
      normalizedStatus: "timed_out",
      rationale: "Automatic approval review timed out while evaluating the requested approval.",
    },
    { status: "aborted", normalizedStatus: "aborted", rationale: null },
  ])("keeps a targeted $normalizedStatus review command-owned", async (terminal) => {
    const { send, events } = await observeProjector();
    if (terminal.rationale) {
      await send(guardianWarning(terminal.rationale));
    }
    await send(
      guardianReview({
        id: `review-${terminal.normalizedStatus}`,
        target: "cmd-terminal",
        status: terminal.status,
        rationale: terminal.rationale,
      }),
    );
    expect(events("codex_app_server.guardian", "warning")).toEqual([]);
    expect(events("tool", "review")).toMatchObject([
      { approvalReviewOutcome: "denied", review: { status: terminal.normalizedStatus } },
    ]);
  });

  it("projects thread-scoped guardian warnings", async () => {
    const { send, projector, onAgentEvent } = await observeProjector();
    const message = "Guardian rejection limit reached; ending turn as interrupted.";
    await send(guardianWarning("Wrong thread.", "thread-other"), guardianWarning(message));
    projector.buildResult(buildEmptyToolTelemetry());
    expect(onAgentEvent.mock.calls.map(([event]) => event.data.message)).toEqual([message]);
  });

  it.each([
    "Configured service tier `priority` is not advertised as supported for model `test-no-tier-model` and will be omitted from requests.",
    "Code Mode is enabled in configuration, but model `gpt-5.6-sol` does not advertise Code Mode support. This may degrade model performance. Disable `features.code_mode` and `features.code_mode_only`, or select a model whose metadata enables Code Mode.",
  ])("keeps only the exact managed warning log-only: %s", async (message) => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const { send, onAgentEvent } = await observeProjector();
    await send({ method: "warning", params: { threadId: THREAD_ID, message } });
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(message);
    const actionable = `${message} Additional action required.`;
    await send({ method: "warning", params: { threadId: THREAD_ID, message: actionable } });
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual([
      { stream: "notice", data: { phase: "warning", message: actionable } },
    ]);
  });

  it("surfaces configuration warnings and ignores another thread", async () => {
    const { send, onAgentEvent } = await observeProjector();
    await send(
      {
        method: "configWarning",
        params: {
          summary: "Error parsing rules; custom rules not applied.",
          details: "rules.toml: unexpected token",
        },
      },
      {
        method: "warning",
        params: { threadId: "another-thread", message: "Other session warning." },
      },
    );
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        stream: "notice",
        data: {
          phase: "warning",
          message: "Error parsing rules; custom rules not applied.\nrules.toml: unexpected token",
        },
      },
    ]);
  });

  it("projects streamed and structured plans without adding them to history", async () => {
    const { send, events, projector, onAgentEvent } = await observeProjector();
    await send(
      forCurrentTurn("item/plan/delta", { itemId: "plan-1", delta: "- inspect\n" }),
      forCurrentTurn("turn/plan/updated", {
        explanation: "next",
        plan: [{ step: "patch", status: "inProgress" }],
      }),
      turnCompleted(),
    );
    expect(events("plan")).toHaveLength(2);
    expect(
      findPlanEventWithSteps(onAgentEvent, [{ step: "inspect", status: "pending" }]).steps,
    ).toEqual([{ step: "inspect", status: "pending" }]);
    expect(
      findPlanEventWithSteps(onAgentEvent, [{ step: "patch", status: "in_progress" }]),
    ).toMatchObject({ explanation: "next", steps: [{ step: "patch", status: "in_progress" }] });
    expect(
      JSON.stringify(projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot),
    ).not.toContain("Codex plan:");
  });

  it("orders streamed reasoning sections and replaces them with authoritative completion", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onReasoningStream,
      onReasoningEnd,
    });
    for (const [method, indexField, prefix] of [
      ["summaryTextDelta", "summaryIndex", ""],
      ["textDelta", "contentIndex", "First section\n\nSecond\n\n"],
    ] as const) {
      for (const [index, delta] of [
        [1, "Second"],
        [0, "First "],
        [0, "section"],
      ] as const) {
        await projector.handleNotification(
          forCurrentTurn(`item/reasoning/${method}`, {
            itemId: "reason-1",
            [indexField]: index,
            delta,
          }),
        );
      }
      expect(onReasoningStream.mock.calls.slice(-3)).toEqual([
        [{ text: `${prefix}Second`, isReasoningSnapshot: true }],
        [{ text: `${prefix}First \n\nSecond`, isReasoningSnapshot: true }],
        [{ text: `${prefix}First section\n\nSecond`, isReasoningSnapshot: true }],
      ]);
    }
    expect(onReasoningStream).toHaveBeenCalledTimes(6);
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "reasoning",
          id: "reason-1",
          summary: ["First summary", "Second summary"],
          content: ["Completed reasoning"],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "reasoning",
          id: "reason-2",
          summary: ["Next item"],
          content: [],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());
    const text = "First summary\n\nSecond summary\n\nCompleted reasoning\n\nNext item";
    expect(onReasoningStream).toHaveBeenLastCalledWith({ text, isReasoningSnapshot: true });
    expect(onReasoningEnd).toHaveBeenCalledOnce();
    expect(projector.buildResult(buildEmptyToolTelemetry()).messagesSnapshot).toContainEqual(
      expect.objectContaining({ content: [{ type: "thinking", thinking: text }] }),
    );
  });
});

describe("CodexAppServerEventProjector started text", () => {
  it.each(["final_answer", "commentary"])(
    "includes started-item text in the %s stream before subsequent deltas",
    async (phase) => {
      const onAgentEvent = vi.fn();
      const onPartialReply = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        onAgentEvent,
        onPartialReply,
      });

      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "msg-1", phase, text: "Hello " },
        }),
      );
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: phase === "commentary" ? "item" : "assistant",
        data: expect.objectContaining(
          phase === "commentary" ? { progressText: "Hello" } : { text: "Hello ", delta: "Hello " },
        ),
      });

      await projector.handleNotification(agentMessageDelta("world"));
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "msg-1", phase, text: "Hello " },
        }),
      );
      await projector.handleNotification(agentMessageDelta("!"));

      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: phase === "commentary" ? "item" : "assistant",
        data: expect.objectContaining(
          phase === "commentary"
            ? { progressText: "Hello world!" }
            : { text: "Hello world!", delta: "!" },
        ),
      });
      if (phase === "commentary") {
        expect(onPartialReply).not.toHaveBeenCalled();
      } else {
        expect(onPartialReply.mock.calls.map(([payload]) => payload)).toEqual([
          { text: "Hello ", delta: "Hello " },
          { text: "Hello world", delta: "world" },
          { text: "Hello world!", delta: "!" },
        ]);
      }
    },
  );
});
