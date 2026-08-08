import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createCodexTestModel,
  createParams,
  createProjector,
  createProjectorWithAssistantHooks,
  buildEmptyToolTelemetry,
  requireRecord,
  expectUsageFields,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
  type EmbeddedRunAttemptParams,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector assistant projection", () => {
  it("projects assistant deltas and usage into embedded attempt results", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "" },
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
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("projects a current-turn model reroute onto the terminal assistant", async () => {
    const projector = await createProjector();
    await projector.handleNotification(
      forCurrentTurn("model/rerouted", {
        fromModel: "gpt-5.4-codex",
        toModel: "gpt-5.4-codex-mini",
        reason: "high_risk_cyber_activity",
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
  });

  it("keeps reopened final answers as Activity candidates until turn completion selects one", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );

    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-2", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Second candidate", "answer-2"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
        lateTool,
        {
          type: "agentMessage",
          id: "answer-2",
          phase: "final_answer",
          text: "Second candidate",
        },
      ]),
    );

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

  it("does not reselect a final answer superseded by late tool work", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "answer-1", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("First candidate", "answer-1"));
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
      }),
    );

    const lateTool = {
      type: "commandExecution",
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "late",
      exitCode: 0,
      durationMs: 1,
    };
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { ...lateTool, status: "inProgress", aggregatedOutput: null, exitCode: null },
      }),
    );
    await projector.handleNotification(forCurrentTurn("item/completed", { item: lateTool }));
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "answer-1",
          phase: "final_answer",
          text: "First candidate",
        },
        lateTool,
      ]),
    );

    const candidateStatuses = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
      .map((event) => event.data.status);
    expect(candidateStatuses).toEqual(["candidate", "superseded"]);
  });

  it("selects an unphased final answer supplied only by the completed-turn snapshot", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "answer-unphased", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.at(-1)).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    );
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "item" && event.data.kind === "answer_candidate")
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({
        itemId: "answer-unphased",
        status: "selected",
        progressText: "done",
        hideFromChannelProgress: true,
      }),
    ]);
  });

  it("streams final-answer assistant deltas into partial replies", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("hel", "msg-final"));
    await projector.handleNotification(agentMessageDelta("lo", "msg-final"));

    expect(onPartialReply).toHaveBeenCalledTimes(2);
    expect(onPartialReply.mock.calls.map((call) => call[0])).toEqual([
      { text: "hel", delta: "hel" },
      { text: "hello", delta: "lo" },
    ]);
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      { stream: "assistant", data: { text: "hel", delta: "hel" } },
      { stream: "assistant", data: { text: "hello", delta: "lo" } },
    ]);
  });

  it("streams assistant deltas when the app-server omits the item phase", async () => {
    // Codex can stream agentMessage deltas without a final-answer phase. Route
    // them through replaceable events, not append-oriented partial callbacks.
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(agentMessageDelta("hel", "msg-final"));
    await projector.handleNotification(agentMessageDelta("lo", "msg-final"));

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAgentEvent.mock.calls.map((call) => call[0])).toEqual([
      { stream: "assistant", data: { text: "hel", delta: "hel", replaceable: true } },
      { stream: "assistant", data: { text: "hello", delta: "lo", replaceable: true } },
    ]);
  });

  it("marks partial replacement when an unphased intermediate item is superseded by a final item", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(agentMessageDelta("coordination ", "msg-intermediate"));
    await projector.handleNotification(agentMessageDelta("draft", "msg-intermediate"));
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "agentMessage", id: "msg-final", phase: "final_answer", text: "" },
      }),
    );
    await projector.handleNotification(agentMessageDelta("final ", "msg-final"));
    await projector.handleNotification(agentMessageDelta("answer", "msg-final"));

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => event.stream === "assistant"),
    ).toEqual([
      {
        stream: "assistant",
        data: { text: "coordination ", delta: "coordination ", replaceable: true },
      },
      {
        stream: "assistant",
        data: { text: "coordination draft", delta: "draft", replaceable: true },
      },
      {
        stream: "assistant",
        data: { text: "final ", delta: "", replace: true, replaceable: true },
      },
      { stream: "assistant", data: { text: "final answer", delta: "answer", replaceable: true } },
    ]);
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

  it("tags mirrored prompts with the exact upstream user text", async () => {
    const projector = await createProjector(undefined, {
      upstreamUserText: "decorated upstream prompt",
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage["__openclaw"]).toMatchObject({
      upstreamUserText: "decorated upstream prompt",
    });
  });

  it("records canonical OpenAI Codex app-server turns with Codex local attribution", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {},
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai");
    expect(result.lastAssistant?.api).toBe("openai-chatgpt-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves OpenAI attribution for Codex app-server OpenAI API-key fallback profiles", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      authProfileId: "openai:work",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai",
          forwardedAuthProfileId: "openai:work",
        },
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai");
    expect(result.lastAssistant?.api).toBe("openai-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves inbound sender metadata on the mirrored user prompt", async () => {
    const params = await createParams();
    const projector = await createProjector({
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
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
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

describe("CodexAppServerEventProjector trailing silent-token shadowing", () => {
  it("keeps the real final answer when a late event is answered with NO_REPLY", async () => {
    const { projector } = await createProjectorWithAssistantHooks();

    // A completed turn that emitted a real answer, then had a late child-completion
    // event steered in and answered with the contract-mandated silent token.
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "here is the answer" },
        { type: "agentMessage", id: "msg-2", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["here is the answer"]);
  });

  it("selects the delivered answer, not the trailing silent token, as the Activity answer", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "here is the answer" },
        { type: "agentMessage", id: "msg-2", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    // Activity's "Selected answer" must agree with what delivery sent; selecting the
    // newest item outright would show NO_REPLY as selected and supersede the real answer.
    const selected = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter(
        (event) =>
          event.stream === "item" &&
          event.data.kind === "answer_candidate" &&
          event.data.status === "selected",
      )
      .map((event) => event.data.itemId);
    expect(selected).toEqual(["msg-1"]);
  });

  it.each([
    ['{"action":"NO_REPLY"}', "json envelope"],
    ['"NO_REPLY"', "quoted json string"],
    ["<think>weighing it up</think>\nNO_REPLY", "reasoning-prefixed"],
  ])("keeps the real answer when the late event answers with %s (%s)", async (silentText) => {
    const { projector } = await createProjectorWithAssistantHooks();

    // Selection must recognize every encoding the delivery layer suppresses; a narrower
    // test would pick the payload as the answer and the turn would go silent again.
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "here is the answer" },
        { type: "agentMessage", id: "msg-2", phase: "final_answer", text: silentText },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["here is the answer"]);
  });

  it("delivers substantive text that merely ends with the silent token", async () => {
    const { projector } = await createProjectorWithAssistantHooks();
    const text = "Here is the answer.\n\nNO_REPLY";

    // Negative control for the widened predicate: only token-only payloads are silence.
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", phase: "final_answer", text }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([text]);
  });

  it("does not treat a silent token superseded by later native work as terminal output", async () => {
    const { projector } = await createProjectorWithAssistantHooks();

    const laterTool = {
      type: "commandExecution",
      id: "cmd-1",
      command: "/bin/bash -lc 'printf done'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "done",
      exitCode: 0,
      durationMs: 1,
    };

    // The silent item completes on the wire, so it becomes the latest completed item;
    // the tool only appears in the turn snapshot. That is the ordering where the
    // streaming guard cannot help, so invalidation must reach the silent branch itself.
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "NO_REPLY" },
      }),
    );
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "NO_REPLY" },
        laterTool,
      ]),
    );

    expect(projector.hasCompletedTerminalAssistantText()).toBe(false);
  });

  it("does not revive a pre-tool answer when native work runs before the silent token", async () => {
    const { projector } = await createProjectorWithAssistantHooks();

    const midTool = {
      type: "commandExecution",
      id: "mid-tool",
      command: "/bin/bash -lc 'printf mid'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "mid",
      exitCode: 0,
      durationMs: 1,
    };

    // Native tool work after the answer supersedes it, exactly as finalizeAnswerCandidate
    // treats it. Reviving it here would deliver a stale pre-tool answer where main stayed
    // silent, so the trailing silent token must still win.
    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "here is the answer" },
        midTool,
        { type: "agentMessage", id: "msg-2", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
  });

  it("stays silent when the only assistant item is NO_REPLY", async () => {
    const { projector } = await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    // Deliberate whole-turn silence must keep the token: downstream terminal
    // classification counts it as intentional output, so dropping it here would
    // let the empty-final fallback fire and break the silence contract.
    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
  });

  it("stays silent when commentary precedes a lone NO_REPLY", async () => {
    const { projector } = await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      turnCompleted([
        { type: "agentMessage", id: "msg-1", phase: "commentary", text: "working on it" },
        { type: "agentMessage", id: "msg-2", phase: "final_answer", text: "NO_REPLY" },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["NO_REPLY"]);
  });
});
