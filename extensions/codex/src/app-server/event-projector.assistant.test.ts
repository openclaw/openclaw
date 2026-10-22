import { normalizeUsage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import { finalMessage as finalItem } from "./event-projector.compact.test-support.js";
import * as fixture from "./event-projector.compact.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  requireRecord,
  expectUsageFields,
  turnWithStatus,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function candidate(itemId: string, status: string, progressText: string, hidden = false) {
  return expect.objectContaining({
    itemId,
    status,
    progressText,
    ...(hidden ? { hideFromChannelProgress: true } : {}),
  });
}

function assistantEvent(itemId: string, text: string, delta = text) {
  return { stream: "assistant", data: { itemId, text, delta, occurrenceId: expect.any(String) } };
}

function terminalReply(text: string) {
  return {
    text,
    terminalReply: text ? { disposition: "visible", text } : { disposition: "silent" },
  };
}

async function streamFinalAnswer(
  projector: Awaited<ReturnType<typeof createProjector>>,
  id: string,
  text: string,
) {
  await fixture.start(projector, finalItem(id, ""));
  await fixture.delta(projector, text, id);
  await fixture.complete(projector, finalItem(id, text));
}

describe("CodexAppServerEventProjector assistant projection", () => {
  it.each(["failed"])("retains streamed partial evidence after a %s turn", async (status) => {
    const projector = await createProjector();
    await fixture.start(projector, finalItem("partial", ""));
    await fixture.delta(projector, "Partial work", "partial");
    await projector.handleNotification(turnWithStatus(status));
    expect(fixture.result(projector).assistantTexts).toEqual(["Partial work"]);
  });

  it.each(["failed", "interrupted"])(
    "preserves native %s ownership when the final text is exact silence",
    async (status) => {
      const projector = await createProjector();
      await streamFinalAnswer(projector, "answer", "NO_REPLY");
      await projector.handleNotification(turnWithStatus(status));
      if (status === "interrupted") {
        projector.markAborted();
      }
      const result = fixture.result(projector);
      expect(result.terminal.kind).not.toBe("ok");
      expect(result.preparedTerminalReply).toEqual(terminalReply(""));
      expect(result.assistantTexts).toEqual([]);
    },
  );

  it.each([
    { answer: "Completed answer.", coda: "NO_REPLY", expected: ["Completed answer."] },
    {
      answer: "Completed answer.",
      coda: "NO_REPLY\nNO_REPLY",
      expected: ["Completed answer.", "NO_REPLY"],
    },
  ])("preserves completed answers before final coda $coda", async ({ answer, coda, expected }) => {
    const projector = await createProjector();
    await streamFinalAnswer(projector, "answer", answer);
    await streamFinalAnswer(projector, "coda", coda);
    await fixture.finish(projector, [finalItem("coda", coda)]);
    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual(expected);
    expect(result.preparedTerminalReply).toEqual(terminalReply(expected.join("\n\n")));
  });

  it("bounds combined terminal snapshots without truncating either delivered answer", async () => {
    const projector = await createProjector();
    const answer = "a".repeat(4_000);
    const coda = "b".repeat(200);
    await streamFinalAnswer(projector, "answer", answer);
    await streamFinalAnswer(projector, "coda", `NO_REPLY\n${coda}`);
    await fixture.finish(projector, [finalItem("coda", `NO_REPLY\n${coda}`)]);

    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual([answer, coda]);
    expect(result.preparedTerminalReply).toEqual({
      text: `${answer}\n\n${coda}`,
      terminalReply: {
        disposition: "visible",
        text: `${answer}\n\n${"b".repeat(93)}…`,
      },
    });
  });

  it("withholds split control text from native partial replies", async () => {
    const onPartialReply = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onPartialReply });
    await fixture.start(projector, finalItem("answer", ""));
    await fixture.delta(projector, "NO_", "answer");
    await fixture.delta(projector, "REPLY", "answer");
    await fixture.complete(projector, finalItem("answer", "NO_REPLY"));
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("streams the completed tail when final deltas stop short of the item text", async () => {
    const { projector, onAgentEvent, onPartialReply } = await fixture.observePartial();
    await fixture.start(projector, finalItem("final", ""));
    await fixture.delta(projector, "CODEX-STEER-48AB12A2581A45", "final");
    await fixture.complete(projector, finalItem("final", "CODEX-STEER-48AB12A2581A45AB"));

    const assistantEvents = fixture.events(onAgentEvent, "assistant");
    expect(assistantEvents.at(-1)?.data).toMatchObject({
      itemId: "final",
      text: "CODEX-STEER-48AB12A2581A45AB",
      delta: "AB",
    });
    expect(onPartialReply).toHaveBeenLastCalledWith({
      text: "CODEX-STEER-48AB12A2581A45AB",
      delta: "AB",
    });
  });

  it.each(
    ["item", "raw", "turn"].flatMap((completion) =>
      ["Final", "NO_REPLY"].map((text) => ({ completion, text })),
    ),
  )(
    "replaces a streamed draft with authoritative $completion text $text",
    async ({ completion, text }) => {
      const { projector, onAgentEvent } = await fixture.observe();
      await fixture.start(projector, finalItem("answer", ""));
      await fixture.delta(projector, "Draft", "answer");
      if (completion === "item") {
        await fixture.complete(projector, finalItem("answer", text));
      } else if (completion === "raw") {
        await fixture.rawAssistant(projector, text, { id: "answer", phase: "final_answer" });
      }
      await fixture.finish(projector, [finalItem("answer", text)]);

      const candidates = fixture.events(onAgentEvent, "item", "answer_candidate").map((event) => ({
        status: event.data.status,
        text: event.data.progressText,
      }));
      expect(candidates).toEqual(
        text === "NO_REPLY"
          ? [
              { status: "candidate", text: "Draft" },
              { status: "superseded", text: "Draft" },
            ]
          : [
              { status: "candidate", text: "Draft" },
              ...(completion === "item" ? [{ status: "candidate", text: "Final" }] : []),
              { status: "selected", text: "Final" },
            ],
      );
      const result = fixture.result(projector);
      expect(result.assistantTexts).toEqual(text === "NO_REPLY" ? [] : ["Final"]);
      expect(result.preparedTerminalReply).toEqual(
        terminalReply(text === "NO_REPLY" ? "" : "Final"),
      );
      expect(result.lastAssistant?.content).toEqual(fixture.text(text));
    },
  );

  it("keeps distinct completed same-text finals and raw-only completion", async () => {
    const projector = await createProjector();
    for (const id of ["completed-1", "completed-2"]) {
      await fixture.complete(projector, finalItem(id, "Repeated intentionally"));
    }
    await fixture.rawAssistant(projector, "Raw completion", {
      id: "raw-only",
      phase: "final_answer",
    });
    await fixture.finish(projector);
    expect(fixture.result(projector).assistantTexts).toEqual([
      "Repeated intentionally",
      "Repeated intentionally",
      "Raw completion",
    ]);
  });

  it("retires the streamed candidate when only the terminal snapshot supplies its replacement", async () => {
    const { projector, onAgentEvent } = await fixture.observe();
    await fixture.start(projector, finalItem("preview", ""));
    await fixture.delta(projector, "Preview answer", "preview");
    await fixture.finish(projector, [finalItem("completed", "Final answer")]);

    expect(
      fixture.events(onAgentEvent, "item", "answer_candidate").map((event) => event.data),
    ).toEqual([
      candidate("preview", "candidate", "Preview answer"),
      candidate("preview", "superseded", "Preview answer"),
      candidate("completed", "selected", "Final answer"),
    ]);
    expect(fixture.result(projector).assistantTexts).toEqual(["Final answer"]);
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

    await fixture.start(projector, finalItem("msg-1", ""));
    await fixture.delta(projector, "hel");
    await fixture.delta(projector, "lo");
    await fixture.notify(projector, "rawResponse/completed", {
      responseId: "response-1",
      usage: {
        totalTokens: 12,
        inputTokens: 5,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 7,
        reasoningOutputTokens: 3,
      },
    });
    await fixture.finish(projector, [fixture.message("msg-1", "hello")]);

    const result = fixture.result(projector);

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply.mock.calls.map((call) => call[0])).toEqual([
      { text: "hel", delta: "hel" },
      { text: "hello", delta: "lo" },
    ]);
    expect(fixture.events(onAgentEvent, "assistant")).toEqual([
      assistantEvent("msg-1", "hel"),
      assistantEvent("msg-1", "hello", "lo"),
    ]);
    expect(result.assistantTexts).toEqual(["hello"]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.lastAssistant?.content).toEqual(fixture.text("hello"));
    expect(result.currentAttemptAssistant?.content).toEqual(fixture.text("hello"));
    for (const usage of [result.attemptUsage, result.lastAssistant?.usage]) {
      expectUsageFields(usage, { input: 2, output: 7, cacheRead: 2, cacheWrite: 1, total: 12 });
      expect(usage?.contextUsage).toEqual({ state: "available", promptTokens: 5, totalTokens: 12 });
    }
    expect(result.attemptUsage?.reasoningTokens).toBe(3);
    expect(normalizeUsage(result.lastAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(normalizeUsage(result.currentAttemptAssistant?.usage)?.reasoningTokens).toBe(3);
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("projects a current-turn model reroute onto the terminal assistant", async () => {
    const { projector, onAgentEvent } = await fixture.observe();
    await fixture.notify(projector, "model/rerouted", {
      fromModel: "gpt-5.4-codex",
      toModel: "gpt-5.4-codex-mini",
      reason: "highRiskCyberActivity",
    });
    await fixture.finish(projector, [fixture.message("msg-rerouted", "done")]);

    const result = fixture.result(projector);

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

  it.each(["Second candidate", "NO_REPLY"])("selects the post-tool final %s", async (answer) => {
    const { projector, onAgentEvent } = await fixture.observe();

    await streamFinalAnswer(projector, "answer-1", "First candidate");

    const lateTool = createNativeCommandItem({
      id: "late-tool",
      command: "/bin/bash -lc 'printf late'",
      aggregatedOutput: "late",
      durationMs: 1,
    });
    await fixture.start(projector, {
      ...lateTool,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    });
    await fixture.complete(projector, lateTool);

    await streamFinalAnswer(projector, "answer-2", answer);
    await fixture.finish(projector, [finalItem("answer-2", answer)]);

    if (answer !== "NO_REPLY") {
      expect(
        fixture.events(onAgentEvent, "item", "answer_candidate").map((event) => event.data),
      ).toEqual([
        candidate("answer-1", "candidate", "First candidate", true),
        candidate("answer-1", "superseded", "First candidate", true),
        candidate("answer-2", "candidate", answer, true),
        candidate("answer-2", "selected", answer, true),
      ]);
    }

    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual(answer === "NO_REPLY" ? [] : [answer]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
    if (answer === "NO_REPLY") {
      expect(result.preparedTerminalReply?.terminalReply).toEqual({ disposition: "silent" });
    } else {
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain("answer_candidate");
    }
  });

  it("keeps an earlier final answer when a later coda arrives with no tool work between them", async () => {
    const { projector, onAgentEvent } = await fixture.observe();
    const summary = "Read-only; inspected actual diffs, no mutations: - #122457 — Copies";
    const coda = "The summary above already incorporates the final review results.";

    await streamFinalAnswer(projector, "answer-1", summary);
    await streamFinalAnswer(projector, "answer-2", coda);
    await fixture.finish(projector, [finalItem("answer-2", coda)]);

    const result = fixture.result(projector);
    const snapshot = JSON.stringify(result.messagesSnapshot);

    expect(fixture.events(onAgentEvent, "assistant")).toEqual([
      assistantEvent("answer-1", summary),
      assistantEvent("answer-2", coda),
    ]);
    expect(result.assistantTexts).toEqual([summary, coda]);
    expect(result.lastAssistant?.content).toEqual(fixture.text(`${summary}\n\n${coda}`));
    expect(snapshot).toContain(summary);
    expect(snapshot).toContain(coda);
  });

  it.each(["Later final", "NO_REPLY"])(
    "selects %s after an unphased replacement",
    async (answer) => {
      const { projector, onAgentEvent } = await fixture.observe();

      await streamFinalAnswer(projector, "answer-1", "First candidate");
      await fixture.delta(projector, "Replacement draft", "answer-2");
      await streamFinalAnswer(projector, "answer-3", answer);
      await fixture.finish(projector, [finalItem("answer-3", answer)]);

      if (answer !== "NO_REPLY") {
        expect(
          fixture
            .events(onAgentEvent, "assistant")
            .map((event) => [event.data.itemId, event.data.replace]),
        ).toEqual([
          ["answer-1", undefined],
          ["answer-2", true],
          ["answer-3", true],
        ]);
      }
      const result = fixture.result(projector);
      expect(result.assistantTexts).toEqual(answer === "NO_REPLY" ? [] : [answer]);
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
      if (answer !== "NO_REPLY") {
        expect(JSON.stringify(result.messagesSnapshot)).not.toContain("Replacement draft");
      } else {
        expect(result.preparedTerminalReply).toEqual(terminalReply(""));
        expect(result.lastAssistant?.content).toEqual(fixture.text("NO_REPLY"));
      }
    },
  );

  it("omits a silent completed answer from the steering transcript boundary", async () => {
    const projector = await createProjector();

    await fixture.complete(projector, finalItem("silent-before-steer", "NO_REPLY"));

    expect(projector.buildSteeringTranscriptPrefix()).toEqual([]);
  });

  it("retains literal control-looking text at a steering boundary", async () => {
    const text = "NO_REPLY\nNO_REPLY";
    const projector = await createProjector();
    await streamFinalAnswer(projector, "before-steer", text);
    expect(projector.buildSteeringTranscriptPrefix()).toEqual([
      expect.objectContaining({ content: fixture.text(text) }),
    ]);
  });

  it("drops a pre-sleep final after a later sleep handoff", async () => {
    const projector = await createProjector();
    const sleepItem = { type: "sleep", id: "sleep-1", durationMs: 250 };

    await streamFinalAnswer(projector, "answer-1", "First candidate");
    await fixture.start(projector, sleepItem);
    await fixture.complete(projector, sleepItem);
    await streamFinalAnswer(projector, "answer-2", "After sleep");
    await fixture.finish(projector, [finalItem("answer-2", "After sleep")]);

    const result = fixture.result(projector);
    expect(result.assistantTexts).toEqual(["After sleep"]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("First candidate");
  });

  it("keeps a final answer that arrives while an earlier native tool is still active", async () => {
    const projector = await createProjector();

    await fixture.start(projector, {
      type: "imageGeneration",
      id: "ig_1",
      status: "inProgress",
    });
    await streamFinalAnswer(projector, "answer-1", "Done.");
    await fixture.complete(projector, {
      type: "imageGeneration",
      id: "ig_1",
      status: "completed",
    });
    await fixture.finish(projector, [finalItem("answer-1", "Done.")]);

    expect(fixture.result(projector).assistantTexts).toEqual(["Done."]);
  });

  it("suppresses mirrored user prompt when the inbound message was already persisted", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      suppressNextUserMessagePersistence: true,
    });
    await fixture.finish(projector, [fixture.message("msg-1", "retry result")]);

    const result = fixture.result(projector);

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

    const result = fixture.result(projector);

    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage).toMatchObject({
      __openclaw: { upstreamUserText: "decorated upstream prompt" },
      role: "user",
      content: "hello",
      sourceChannel: "discord",
      senderId: "user-123",
      senderName: "Test User",
      senderUsername: "testuser",
      senderLabel: "Test User (user-123)",
    });
    expect(userMessage.provenance).toEqual({ kind: "external_user", sourceChannel: "discord" });
  });
});
