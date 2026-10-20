import { finalMessage as finalItem } from "./event-projector.compact.test-support.js";
import * as fixture from "./event-projector.compact.test-support.js";
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
  forCurrentTurn,
  turnCompleted,
  THREAD_ID,
  requireRecord,
  findPlanEventWithSteps,
  type ProjectorNotification,
} from "./event-projector.test-harness.js";
import { prepareCodexServerNotification } from "./protocol-validators.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

registerCodexEventProjectorTestLifecycle();

function commentaryItem(id: string, text = "") {
  return fixture.message(id, text, "commentary");
}

describe("CodexAppServerEventProjector text and guardian projection", () => {
  it("keeps intermediate agentMessage items out of the final visible reply", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();
    const draft = "checking thread context";
    const answer = "Final answer.";

    await fixture.delta(projector, draft, "msg-commentary");
    await fixture.delta(projector, answer, "msg-final");
    await fixture.finish(projector, [
      fixture.message("msg-commentary", draft),
      fixture.message("msg-final", answer),
    ]);

    const result = fixture.result(projector);

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    // Unphased previews must remain replaceable, not append-only channel replies.
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(result.assistantTexts).toEqual([answer]);
    expect(result.lastAssistant?.content).toEqual(fixture.text(answer));
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("checking thread context");
  });

  it("preserves an explicit raw empty stop without an id after a settled write", async () => {
    const { projector, onAgentEvent } = await fixture.observe();
    const priorAssistant = fixture.message("msg-before-write", "");
    await fixture.start(projector, priorAssistant);
    await fixture.complete(projector, priorAssistant);
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
    await fixture.start(projector, item);
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
    await fixture.complete(projector, {
      ...item,
      status: "completed",
      contentItems: [{ type: "inputText", text: "written once" }],
      success: true,
      durationMs: 1,
    });
    await fixture.rawAssistant(projector, " \n ");
    await fixture.finish(projector, []);

    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
    expect(result.currentAttemptAssistant).toMatchObject({
      stopReason: "stop",
      content: fixture.text(""),
    });
    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
    expect(result.itemLifecycle).toEqual({ startedCount: 2, completedCount: 2, activeCount: 0 });
    expect(result.messagesSnapshot.filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({ content: [expect.objectContaining({ type: "toolCall" })] }),
    ]);
    expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "assistant")).toBe(false);
  });

  it.each([
    { label: "missing text", content: [{ type: "output_text" }] },
    { label: "non-text content", content: [{ type: "reasoning", text: "" }] },
  ])("does not fabricate a terminal assistant for $label", async ({ content }) => {
    const projector = await createProjector();
    await fixture.notify(projector, "rawResponseItem/completed", {
      item: { type: "message", role: "assistant", content },
    });
    await fixture.finish(projector, []);

    expect(fixture.result(projector).currentAttemptAssistant).toBeUndefined();
  });

  it.each(["started", "completed"])(
    "hands off formatted commentary identified at item/%s",
    async (phaseKnownAt) => {
      const { projector, onAgentEvent, onPartialReply } = await fixture.observePartial();
      const commentaryText =
        "Checking\n\n| Intent | Command |\n| --- | --- |\n| Session | `/model` |\n\n```text\nBEFORE → persistent\nAFTER → session\n```";

      await fixture.start(
        projector,
        phaseKnownAt === "started"
          ? commentaryItem("msg-commentary")
          : fixture.message("msg-commentary", ""),
      );
      await fixture.delta(projector, "Checking", "msg-commentary");
      await fixture.delta(projector, commentaryText.slice("Checking".length), "msg-commentary");
      if (phaseKnownAt === "completed") {
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { itemId: "msg-commentary", text: commentaryText },
        });
      }
      // Identical completion snapshots must not dedupe the first buffered channel notification.
      await fixture.complete(projector, commentaryItem("msg-commentary", commentaryText));
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
      await fixture.finish(projector, [
        finalItem("msg-final", "final answer"),
        commentaryItem("msg-commentary", commentaryText),
      ]);

      const progressEvents = fixture.events(onAgentEvent, "item", "preamble");

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

      const result = fixture.result(projector);
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
        content: fixture.text(commentaryText),
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

    await fixture.finish(projector, [
      commentaryItem("msg-commentary", "Checking the workspace"),
      finalItem("msg-final", "Done"),
    ]);

    const result = fixture.result(projector);
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

    await fixture.start(projector, commentaryItem("msg-before-tool"));
    await fixture.delta(projector, "Before the tool", "msg-before-tool");

    projector.recordDynamicToolCall({ callId: "call-search", tool: "memory_search" });
    projector.recordDynamicToolResult({
      callId: "call-search",
      tool: "memory_search",
      success: true,
      contentItems: [{ type: "inputText", text: "found it" }],
    });

    await fixture.start(projector, commentaryItem("msg-after-tool"));
    await fixture.delta(projector, "After the tool", "msg-after-tool");
    await fixture.finish(projector, [
      commentaryItem("msg-before-tool", "Before the tool"),
      commentaryItem("msg-after-tool", "After the tool"),
      finalItem("msg-final", "Done"),
    ]);

    const result = fixture.result(projector);
    const identities = result.messagesSnapshot
      .map(readMirrorIdentity)
      .filter((identity) => identity?.includes(":commentary:") || identity?.includes(":tool:"));
    expect(identities).toEqual([
      `${TURN_ID}:commentary:msg-before-tool`,
      `${TURN_ID}:tool:call-search:call`,
      `${TURN_ID}:tool:call-search:result`,
      `${TURN_ID}:commentary:msg-after-tool`,
    ]);
  });

  it("pairs a raw commentary echo after an empty typed completion", async () => {
    const { projector, onAgentEvent } = await fixture.observe();

    await fixture.start(projector, fixture.message("msg-commentary", "", "commentary"));
    await fixture.complete(projector, commentaryItem("msg-commentary"));
    await fixture.rawAssistant(projector, "<oai-mem-citation>source</oai-mem-citation>", {
      id: "msg-commentary",
      phase: "commentary",
    });

    const preambles = fixture.events(onAgentEvent, "item", "preamble");

    expect(preambles).toEqual([]);

    await fixture.rawAssistant(projector, "Later raw-only note", { phase: "commentary" });
    await fixture.finish(projector, []);

    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual([]);
    expect(
      result.messagesSnapshot
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([fixture.text("Later raw-only note")]);
  });
  const guardianWarning = (message: string) =>
    prepareCodexServerNotification({
      method: "guardianWarning",
      params: { threadId: THREAD_ID, message },
    });

  function guardianReview({
    id,
    target = "cmd-1",
    phase = "completed",
    action,
    ...review
  }: {
    id: string;
    status: string;
    target?: string | null;
    phase?: "started" | "completed";
    riskLevel?: string;
    userAuthorization?: string;
    rationale?: string | null;
    action?: Record<string, unknown>;
  }): ProjectorNotification {
    return forCurrentTurn(`item/autoApprovalReview/${phase}`, {
      reviewId: id,
      targetItemId: target,
      ...(phase === "completed" ? { decisionSource: "agent" } : {}),
      review,
      action: action ?? {
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
    const { send, events, projector } = await fixture.observe();
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
    const toolResult = fixture
      .result(projector)
      .messagesSnapshot.find((message) => message.role === "toolResult");
    expect(requireRecord(toolResult, "reviewed tool result").details).toMatchObject({
      approvalReviews: [{ id: "review-1", status: "approved" }],
      approvalReviewOutcome: "approved",
    });
    expect(fixture.result(projector).didSendDeterministicApprovalPrompt).toBe(false);
  });

  it("flushes warnings at targetless, unrelated, and finalization boundaries", async () => {
    const { send, events, projector, onAgentEvent } = await fixture.observe();
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
    fixture.result(projector);
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

  it("bounds rows without losing a reviewing aggregate", async () => {
    const { send, events, projector } = await fixture.observe();
    await send(commandItem("started", "cmd-many-reviews"));
    for (let index = 0; index < 18; index += 1) {
      const status = index === 0 ? "inProgress" : "approved";
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
    expect(events("tool", "review").at(-1)?.approvalReviewOutcome).toBe("reviewing");
    await send(commandItem("completed", "cmd-many-reviews"));
    const toolResult = fixture
      .result(projector)
      .messagesSnapshot.find((message) => message.role === "toolResult");
    expect(requireRecord(toolResult, "bounded review tool result").details).toMatchObject({
      approvalReviews: Array.from({ length: 16 }, (_, index) => ({ id: `review-${index + 2}` })),
      approvalReviewOutcome: "approved",
    });
    expect(events("tool", "result")[0]?.approvalReviewOutcome).toBe("approved");
  });

  it("keeps a targeted timed_out review command-owned", async () => {
    const { send, events } = await fixture.observe();
    const rationale =
      "Automatic approval review timed out while evaluating the requested approval.";
    await send(guardianWarning(rationale));
    await send(
      guardianReview({
        id: "review-timed_out",
        target: "cmd-terminal",
        status: "timedOut",
        rationale,
      }),
    );
    expect(events("codex_app_server.guardian", "warning")).toEqual([]);
    expect(events("tool", "review")).toMatchObject([
      { approvalReviewOutcome: "denied", review: { status: "timed_out" } },
    ]);
  });

  it("surfaces configuration warnings and ignores another thread", async () => {
    const { send, onAgentEvent } = await fixture.observe();
    await send(
      prepareCodexServerNotification({
        method: "configWarning",
        params: {
          summary: "Error parsing rules; custom rules not applied.",
          details: "rules.toml: unexpected token",
        },
      }),
      prepareCodexServerNotification({
        method: "warning",
        params: { threadId: "another-thread", message: "Other session warning." },
      }),
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
    const { send, events, projector, onAgentEvent } = await fixture.observe();
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
    expect(JSON.stringify(fixture.result(projector).messagesSnapshot)).not.toContain("Codex plan:");
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
        await fixture.notify(projector, `item/reasoning/${method}`, {
          itemId: "reason-1",
          [indexField]: index,
          delta,
        });
      }
      expect(onReasoningStream.mock.calls.slice(-3)).toEqual([
        [{ text: `${prefix}Second`, isReasoningSnapshot: true }],
        [{ text: `${prefix}First \n\nSecond`, isReasoningSnapshot: true }],
        [{ text: `${prefix}First section\n\nSecond`, isReasoningSnapshot: true }],
      ]);
    }
    expect(onReasoningStream).toHaveBeenCalledTimes(6);
    await fixture.complete(projector, {
      type: "reasoning",
      id: "reason-1",
      summary: ["First summary", "Second summary"],
      content: ["Completed reasoning"],
    });
    await fixture.complete(projector, {
      type: "reasoning",
      id: "reason-2",
      summary: ["Next item"],
      content: [],
    });
    await fixture.finish(projector);
    const text = "First summary\n\nSecond summary\n\nCompleted reasoning\n\nNext item";
    expect(onReasoningStream).toHaveBeenLastCalledWith({ text, isReasoningSnapshot: true });
    expect(onReasoningEnd).toHaveBeenCalledOnce();
    expect(fixture.result(projector).messagesSnapshot).toContainEqual(
      expect.objectContaining({ content: [{ type: "thinking", thinking: text }] }),
    );
  });
});

it("includes started-item text in the final_answer stream before subsequent deltas", async () => {
  const { projector, onAgentEvent, onPartialReply } = await fixture.observePartial();

  await fixture.start(projector, finalItem("msg-1", "Hello "));
  expect(onAgentEvent).toHaveBeenCalledWith({
    stream: "assistant",
    data: expect.objectContaining({ text: "Hello ", delta: "Hello " }),
  });

  await fixture.delta(projector, "world");
  await fixture.start(projector, finalItem("msg-1", "Hello "));
  await fixture.delta(projector, "!");

  expect(onAgentEvent).toHaveBeenCalledWith({
    stream: "assistant",
    data: expect.objectContaining({ text: "Hello world!", delta: "!" }),
  });
  expect(onPartialReply.mock.calls.map(([payload]) => payload)).toEqual([
    { text: "Hello ", delta: "Hello " },
    { text: "Hello world", delta: "world" },
    { text: "Hello world!", delta: "!" },
  ]);
});
