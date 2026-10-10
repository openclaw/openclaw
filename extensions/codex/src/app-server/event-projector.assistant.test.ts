import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  requireRecord,
  expectUsageFields,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  turnWithStatus,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function finalItem(id: string, text: string) {
  return { type: "agentMessage", id, phase: "final_answer", text };
}

async function streamFinalAnswer(
  projector: Awaited<ReturnType<typeof createProjector>>,
  id: string,
  text: string,
) {
  await projector.handleNotification(
    forCurrentTurn("item/started", {
      item: finalItem(id, ""),
    }),
  );
  await projector.handleNotification(agentMessageDelta(text, id));
  await projector.handleNotification(
    forCurrentTurn("item/completed", {
      item: finalItem(id, text),
    }),
  );
}

describe("CodexAppServerEventProjector assistant projection", () => {
  it.each(["failed"])("retains streamed partial evidence after a %s turn", async (status) => {
    const projector = await createProjector(await createParams());
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: finalItem("partial", ""),
      }),
    );
    await projector.handleNotification(agentMessageDelta("Partial work", "partial"));
    await projector.handleNotification(turnWithStatus(status));
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "Partial work",
    ]);
  });

  it("keeps distinct completed same-text finals and raw-only completion", async () => {
    const projector = await createProjector(await createParams());
    for (const id of ["completed-1", "completed-2"]) {
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: { type: "agentMessage", id, phase: "final_answer", text: "Repeated intentionally" },
        }),
      );
    }
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-only",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Raw completion" }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "Repeated intentionally",
      "Repeated intentionally",
      "Raw completion",
    ]);
  });

  it("retires the streamed candidate when only the terminal snapshot supplies its replacement", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: finalItem("preview", ""),
      }),
    );
    await projector.handleNotification(agentMessageDelta("Preview answer", "preview"));
    await projector.handleNotification(turnCompleted([finalItem("completed", "Final answer")]));

    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({
        itemId: "preview",
        status: "candidate",
        progressText: "Preview answer",
      }),
      expect.objectContaining({
        itemId: "preview",
        status: "superseded",
        progressText: "Preview answer",
      }),
      expect.objectContaining({
        itemId: "completed",
        status: "selected",
        progressText: "Final answer",
      }),
    ]);
    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
      "Final answer",
    ]);
  });

  it("projects assistant deltas and usage into embedded attempt results", async () => {
    const onAssistantMessageStart = vi.fn();
    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAssistantMessageStart,
      onPartialReply,
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: finalItem("msg-1", ""),
      }),
    );
    await projector.handleNotification(agentMessageDelta("hel"));
    await projector.handleNotification(agentMessageDelta("lo"));
    await projector.handleNotification(
      forCurrentTurn("rawResponse/completed", {
        responseId: "response-1",
        usage: {
          totalTokens: 12,
          inputTokens: 5,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
          outputTokens: 7,
          reasoningOutputTokens: 3,
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "hello" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls.map((call) => call[0])).toEqual([
      { text: "hel", delta: "hel" },
      { text: "hello", delta: "lo" },
    ]);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      {
        stream: "assistant",
        data: { itemId: "msg-1", text: "hel", delta: "hel", occurrenceId: expect.any(String) },
      },
      {
        stream: "assistant",
        data: { itemId: "msg-1", text: "hello", delta: "lo", occurrenceId: expect.any(String) },
      },
    ]);
    expect(result.assistantTexts).toEqual(["hello"]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.currentAttemptAssistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expectUsageFields(result.attemptUsage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.attemptUsage?.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expect(result.attemptUsage?.reasoningTokens).toBe(3);
    expectUsageFields(result.lastAssistant?.usage, {
      input: 2,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      total: 12,
    });
    expect(result.lastAssistant?.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 5,
      totalTokens: 12,
    });
    expect(normalizeUsage(result.lastAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(normalizeUsage(result.currentAttemptAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("projects a current-turn model reroute onto the terminal assistant", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    await projector.handleNotification(
      forCurrentTurn("model/rerouted", {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "highRiskCyberActivity",
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-rerouted", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.currentAttemptAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result.lastAssistant?.responseModel).toBe("gpt-5.4-codex-mini");
    expect(result).toMatchObject({
      terminalTurnId: "turn-1",
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "fallback",
      data: {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "highRiskCyberActivity",
      },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "notice",
      data: {
        phase: "provider_policy",
        category: "cyber",
        state: "fallback",
        provider: "openai",
        model: "gpt-5.4-codex",
        fallbackModel: "gpt-5.4-codex-mini",
      },
    });
  });

  it("keeps reopened final answers as Activity candidates until turn completion selects one", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await streamFinalAnswer(projector, "answer-1", "First candidate");

    const lateTool = createNativeCommandItem({
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      aggregatedOutput: "late",
      durationMs: 1,
    });
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));

    await streamFinalAnswer(projector, "answer-2", "Second candidate");
    await projector.handleNotification(turnCompleted([finalItem("answer-2", "Second candidate")]));

    const candidateEvents = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
      .map((event) => event.data);
    expect(candidateEvents).toEqual([
      expect.objectContaining({
        itemId: "answer-1",
        status: "candidate",
        progressText: "First candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-1",
        status: "superseded",
        progressText: "First candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-2",
        status: "candidate",
        progressText: "Second candidate",
        hideFromChannelProgress: true,
      }),
      expect.objectContaining({
        itemId: "answer-2",
        status: "selected",
        progressText: "Second candidate",
        hideFromChannelProgress: true,
      }),
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Second candidate"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("answer_candidate");
  });

  it("keeps an earlier final answer when a later coda arrives with no tool work between them", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const summary = "Read-only; inspected actual diffs, no mutations: - #122457 — Copies";
    const coda = "The summary above already incorporates the final review results.";

    await streamFinalAnswer(projector, "answer-1", summary);
    await streamFinalAnswer(projector, "answer-2", coda);
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: coda,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const snapshot = JSON.stringify(result.messagesSnapshot);

    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      {
        stream: "assistant",
        data: {
          itemId: "answer-1",
          text: summary,
          delta: summary,
          occurrenceId: expect.any(String),
        },
      },
      {
        stream: "assistant",
        data: { itemId: "answer-2", text: coda, delta: coda, occurrenceId: expect.any(String) },
      },
    ]);
    expect(result.assistantTexts).toEqual([summary, coda]);
    expect(result.lastAssistant?.content).toEqual([
      { type: "text", text: `${summary}\n\n${coda}` },
    ]);
    expect(snapshot).toContain(summary);
    expect(snapshot).toContain(coda);
  });

  it("drops a pre-unphased final when a later final follows the replacement", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await streamFinalAnswer(projector, "answer-1", "First candidate");
    await projector.handleNotification(agentMessageDelta("Replacement draft", "answer-2"));
    await streamFinalAnswer(projector, "answer-3", "Later final");
    await projector.handleNotification(turnCompleted([finalItem("answer-3", "Later final")]));

    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant")
        .map((event) => [event.data.itemId, event.data.replace]),
    ).toEqual([
      ["answer-1", undefined],
      ["answer-2", true],
      ["answer-3", true],
    ]);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Later final"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Replacement draft");
  });

  it("keeps the unphased replacement when a later silent final follows", async () => {
    const projector = await createProjector(await createParams());

    await streamFinalAnswer(projector, "answer-1", "First candidate");
    await projector.handleNotification(agentMessageDelta("Replacement draft", "answer-2"));
    await streamFinalAnswer(projector, "answer-3", "NO_REPLY");
    await projector.handleNotification(turnCompleted([finalItem("answer-3", "NO_REPLY")]));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["Replacement draft"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("NO_REPLY");
  });

  it("omits a silent completed answer from the steering transcript boundary", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: finalItem("silent-before-steer", "NO_REPLY"),
      }),
    );

    expect(projector.buildSteeringTranscriptPrefix()).toEqual([]);
  });

  it("drops a pre-sleep final after a later sleep handoff", async () => {
    const projector = await createProjector(await createParams());
    const sleepItem = { type: "sleep", id: "sleep-1", durationMs: 250 };

    await streamFinalAnswer(projector, "answer-1", "First candidate");
    await projector.handleNotification(forCurrentTurn("item/started", { item: sleepItem }));
    await projector.handleNotification(forCurrentTurn("item/completed", { item: sleepItem }));
    await streamFinalAnswer(projector, "answer-2", "After sleep");
    await projector.handleNotification(turnCompleted([finalItem("answer-2", "After sleep")]));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["After sleep"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("keeps a final answer that arrives while an earlier native tool is still active", async () => {
    const projector = await createProjector(await createParams());

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "imageGeneration", id: "ig_1", status: "inProgress" },
      }),
    );
    await streamFinalAnswer(projector, "answer-1", "Done.");
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "imageGeneration", id: "ig_1", status: "completed" },
      }),
    );
    await projector.handleNotification(turnCompleted([finalItem("answer-1", "Done.")]));

    expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual(["Done."]);
  });

  it("keeps a post-handoff silent final instead of recovering the pre-tool answer", async () => {
    const projector = await createProjector(await createParams());
    const lateTool = createNativeCommandItem({
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      aggregatedOutput: "late",
      durationMs: 1,
    });

    await streamFinalAnswer(projector, "answer-1", "First candidate");
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));
    await streamFinalAnswer(projector, "answer-2", "NO_REPLY");
    await projector.handleNotification(turnCompleted([finalItem("answer-2", "NO_REPLY")]));

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("suppresses mirrored user prompt when the inbound message was already persisted", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      suppressNextUserMessagePersistence: true,
    });
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "retry result" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["assistant"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain(params.prompt);
  });

  it("preserves upstream text and sender metadata on the mirrored user prompt", async () => {
    const params = await createParams();
    const projector = await createProjector(
      {
        ...params,
        messageChannel: "discord",
        messageProvider: "discord-voice",
        senderId: "user-123",
        senderName: "Test User",
        senderUsername: "testuser",
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "discord",
        },
      },
      { upstreamUserText: "decorated upstream prompt" },
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage["__openclaw"]).toMatchObject({
      upstreamUserText: "decorated upstream prompt",
    });
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe("hello");
    expect(userMessage.sourceChannel).toBe("discord");
    expect(userMessage.senderId).toBe("user-123");
    expect(userMessage.senderName).toBe("Test User");
    expect(userMessage.senderUsername).toBe("testuser");
    expect(userMessage.senderLabel).toBe("Test User (user-123)");
    expect(userMessage.provenance).toEqual({
      kind: "external_user",
      sourceChannel: "discord",
    });
  });
});
