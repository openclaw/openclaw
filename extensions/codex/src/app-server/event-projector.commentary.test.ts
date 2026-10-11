import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  TURN_ID,
  createParams,
  createProjector,
  createProjectorWithAssistantHooks,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  THREAD_ID,
  requireRecord,
  findPlanEventWithSteps,
  type ProjectorNotification,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function commentaryItem(id: string, text = "") {
  return { type: "agentMessage", id, phase: "commentary", text };
}

describe("CodexAppServerEventProjector commentary projection", () => {
  it("keeps intermediate agentMessage items out of the final visible reply", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();
    const draft = "checking thread context; then post a tight progress reply here.";
    const answer =
      "release fixes first. please drop affected PRs, failing checks, and blockers here.";

    await projector.handleNotification(agentMessageDelta(draft, "msg-commentary"));
    await projector.handleNotification(agentMessageDelta(answer, "msg-final"));
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          text: draft,
        },
        {
          type: "agentMessage",
          id: "msg-final",
          text: answer,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    // Phase-less snapshots stay on the replaceable agent-event path so legacy
    // append-only channel previews do not render superseded coordination text.
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(result.assistantTexts).toEqual([answer]);
    expect(result.lastAssistant?.content).toEqual([
      {
        type: "text",
        text: answer,
      },
    ]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("checking thread context");
  });

  it.each([{ itemId: undefined, text: " \n " }])(
    "preserves an explicit raw empty stop ($itemId) after a settled write",
    async ({ itemId, text }) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...(await createParams()), onAgentEvent });
      const priorAssistant = { type: "agentMessage", id: "msg-before-write", text: "" };
      await projector.handleNotification(forCurrentTurn("item/started", { item: priorAssistant }));
      await projector.handleNotification(
        forCurrentTurn("item/completed", { item: priorAssistant }),
      );
      const item = {
        type: "dynamicToolCall",
        id: "call-write",
        namespace: null,
        tool: "write",
        arguments: { path: "note.txt", content: "written once" },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      projector.recordDynamicToolCall({
        callId: item.id,
        tool: item.tool,
        arguments: item.arguments,
      });
      projector.recordDynamicToolResult({
        callId: item.id,
        tool: item.tool,
        success: true,
        sideEffectEvidence: true,
        contentItems: [{ type: "inputText", text: "written once" }],
      });
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            ...item,
            status: "completed",
            contentItems: [{ type: "inputText", text: "written once" }],
            success: true,
            durationMs: 1,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            ...(itemId ? { id: itemId } : {}),
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        }),
      );
      await projector.handleNotification(turnCompleted([]));

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual([]);
      expect(result.lastAssistant).toBeUndefined();
      expect(result.currentAttemptAssistant).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "" }],
      });
      expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
      expect(result.itemLifecycle).toEqual({ startedCount: 2, completedCount: 2, activeCount: 0 });
      expect(result.messagesSnapshot.filter((message) => message.role === "assistant")).toEqual([
        expect.objectContaining({ content: [expect.objectContaining({ type: "toolCall" })] }),
      ]);
      expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "assistant")).toBe(false);
    },
  );

  it.each([
    { label: "missing text", content: [{ type: "output_text" }] },
    { label: "non-text content", content: [{ type: "reasoning", text: "" }] },
  ])("does not fabricate a terminal assistant for $label", async ({ content }) => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: { type: "message", role: "assistant", content },
      }),
    );
    await projector.handleNotification(turnCompleted([]));

    expect(
      projector.buildResult(buildEmptyToolTelemetry()).currentAttemptAssistant,
    ).toBeUndefined();
  });

  it.each(["started", "completed"])(
    "hands off formatted commentary identified at item/%s",
    async (phaseKnownAt) => {
      const onAgentEvent = vi.fn();
      const onPartialReply = vi.fn();
      const commentaryText = [
        "Checking the app-server stream",
        "",
        "| Intent | Command |",
        "| --- | --- |",
        "| Session only | `/model opus` |",
        "",
        "```text",
        "BEFORE  /model opus  → persistent",
        "AFTER   /model opus  → session only",
        "```",
      ].join("\n");
      const projector = await createProjector({
        ...(await createParams()),
        onAgentEvent,
        onPartialReply,
      });

      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item:
            phaseKnownAt === "started"
              ? commentaryItem("msg-commentary")
              : { type: "agentMessage", id: "msg-commentary", text: "" },
        }),
      );
      await projector.handleNotification(agentMessageDelta("Checking", "msg-commentary"));
      await projector.handleNotification(
        agentMessageDelta(commentaryText.slice("Checking".length), "msg-commentary"),
      );
      if (phaseKnownAt === "completed") {
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { itemId: "msg-commentary", text: commentaryText },
        });
      }
      // The completion boundary lets channels buffer their first notification;
      // text-only dedupe must not erase it after the final identical snapshot.
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: commentaryItem("msg-commentary", commentaryText),
        }),
      );
      if (phaseKnownAt === "completed") {
        expect(
          onAgentEvent.mock.calls
            .map(([event]) => event)
            .filter((event) => event.stream === "assistant" || event.stream === "item")
            .slice(-2),
        ).toMatchObject([
          {
            stream: "assistant",
            data: { itemId: "msg-commentary", text: "", delta: "", replace: true },
          },
          {
            stream: "item",
            data: { kind: "preamble", itemId: "msg-commentary", progressText: commentaryText },
          },
        ]);
      }
      await projector.handleNotification(
        turnCompleted([
          { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "final answer" },
          commentaryItem("msg-commentary", commentaryText),
        ]),
      );

      const progressEvents = onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "preamble");

      expect(onPartialReply).not.toHaveBeenCalled();
      const preamble = {
        itemId: "msg-commentary",
        kind: "preamble",
        title: "Preamble",
        source: "codex-app-server",
      };
      expect(progressEvents.map((event) => event.data)).toEqual([
        ...(phaseKnownAt === "started"
          ? [
              { ...preamble, phase: "update", progressText: "Checking" },
              { ...preamble, phase: "update", progressText: commentaryText },
            ]
          : []),
        { ...preamble, phase: "end", progressText: commentaryText },
      ]);

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual(["final answer"]);
      const commentary = result.messagesSnapshot.find(
        (message) =>
          requireRecord(
            requireRecord(message, "assistant snapshot").openclawStreamFallback ?? {},
            "commentary fallback",
          ).itemId === "msg-commentary",
      );
      expect(commentary).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: commentaryText }],
        openclawStreamFallback: {
          replacementText: commentaryText,
          source: "segment",
          itemId: "msg-commentary",
        },
        __openclaw: { mirrorIdentity: `${TURN_ID}:commentary:msg-commentary` },
      });
      expect(requireRecord(commentary, "commentary message").phase).toBeUndefined();
    },
  );

  it("omits durable commentary when the operator explicitly disables persistence", async () => {
    const params = await createParams();
    params.config = { ui: { prefs: { chatPersistCommentary: false } } };
    const projector = await createProjector(params);

    await projector.handleNotification(
      turnCompleted([
        commentaryItem("msg-commentary", "Checking the workspace"),
        { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "Done" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Done"]);
    expect(
      result.messagesSnapshot.some(
        (message) =>
          (message as { openclawStreamFallback?: { itemId?: unknown } }).openclawStreamFallback
            ?.itemId === "msg-commentary",
      ),
    ).toBe(false);
  });

  it("mirrors commentary and tool activity in event order when timestamps collide", async () => {
    const projector = await createProjector();
    vi.spyOn(Date, "now").mockReturnValue(100);

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: commentaryItem("msg-before-tool"),
      }),
    );
    await projector.handleNotification(agentMessageDelta("Before the tool", "msg-before-tool"));

    projector.recordDynamicToolCall({ callId: "call-search", tool: "memory_search" });
    projector.recordDynamicToolResult({
      callId: "call-search",
      tool: "memory_search",
      success: true,
      contentItems: [{ type: "inputText", text: "found it" }],
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: commentaryItem("msg-after-tool"),
      }),
    );
    await projector.handleNotification(agentMessageDelta("After the tool", "msg-after-tool"));
    await projector.handleNotification(
      turnCompleted([
        commentaryItem("msg-before-tool", "Before the tool"),
        commentaryItem("msg-after-tool", "After the tool"),
        { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "Done" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const identities = result.messagesSnapshot.flatMap((message) => {
      const identity = (message as { __openclaw?: { mirrorIdentity?: unknown } })["__openclaw"]
        ?.mirrorIdentity;
      return typeof identity === "string" &&
        (identity.includes(":commentary:") || identity.includes(":tool:"))
        ? [identity]
        : [];
    });
    expect(identities).toEqual([
      `${TURN_ID}:commentary:msg-before-tool`,
      `${TURN_ID}:tool:call-search:call`,
      `${TURN_ID}:tool:call-search:result`,
      `${TURN_ID}:commentary:msg-after-tool`,
    ]);
  });

  it.each([
    {
      label: "empty",
      text: "",
      rawText: "<oai-mem-citation>source</oai-mem-citation>",
      expectedNotes: [],
    },
  ])(
    "pairs a raw commentary echo after a $label typed completion",
    async ({ text, rawText, expectedNotes }) => {
      const onAgentEvent = vi.fn();
      const projector = await createProjector({
        ...(await createParams()),
        onAgentEvent,
      });

      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: { type: "agentMessage", id: "msg-commentary", phase: "commentary", text: "" },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "agentMessage",
            id: "msg-commentary",
            phase: "commentary",
            text,
          },
        }),
      );
      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            id: "msg-commentary",
            content: [{ type: "output_text", text: rawText }],
          },
        }),
      );

      const preambles = onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "preamble");

      expect(preambles.map((event) => event.data.progressText)).toEqual(expectedNotes);
      expect(preambles.every((event) => event.data.itemId === "msg-commentary")).toBe(true);

      await projector.handleNotification(
        forCurrentTurn("rawResponseItem/completed", {
          item: {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "Later raw-only note" }],
          },
        }),
      );
      await projector.handleNotification(turnCompleted([]));

      const result = projector.buildResult(buildEmptyToolTelemetry());
      expect(result.assistantTexts).toEqual([]);
      expect(
        result.messagesSnapshot
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      ).toEqual(
        [...expectedNotes, "Later raw-only note"].map((note) => [{ type: "text", text: note }]),
      );
    },
  );
});

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

  it.each([{ firstStatus: "inProgress", liveOutcome: "reviewing", persistedOutcome: "approved" }])(
    "bounds rows without losing a $liveOutcome aggregate",
    async (scenario) => {
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
    },
  );

  it.each([
    {
      status: "timedOut",
      normalizedStatus: "timed_out",
      rationale: "Automatic approval review timed out while evaluating the requested approval.",
    },
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
  it.each(["final_answer"])(
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
