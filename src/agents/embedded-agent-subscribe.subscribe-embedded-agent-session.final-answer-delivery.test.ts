import {
  AssistantMessageEventStream,
  type Message,
  type Model,
  type AssistantMessage,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
  THINKING_TAG_CASES,
  createReasoningFinalAnswerMessage,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
function setup(options: Options = {}) {
  const onBlockReply = vi.fn();
  const harness = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply,
    blockReplyBreak: "text_end",
    ...options,
  });
  onTestFinished(() => harness.subscription.unsubscribe());
  return { ...harness, onBlockReply, texts: () => extractTextPayloads(onBlockReply.mock.calls) };
}
type Harness = ReturnType<typeof setup>;
function expectSingle(h: Harness, text: string) {
  expect(h.onBlockReply).toHaveBeenCalledTimes(1);
  expect(h.texts()).toEqual([text]);
  expect(h.subscription.assistantTexts).toEqual([text]);
}
function responsePair(
  h: Harness,
  text: string,
  id: string,
  phase?: OpenAiResponsesTextEventPhase,
  delta?: string,
) {
  const event = { text, id, delta, signaturePhase: phase, partialPhase: phase };
  for (const type of ["text_delta", "text_end"] as const) {
    h.emit(createOpenAiResponsesTextEvent({ type, ...event }));
  }
}
function block(text: string, id: string, phase?: OpenAiResponsesTextEventPhase) {
  return createOpenAiResponsesTextBlock({ text, id, phase });
}

describe("Responses final delivery", () => {
  it("does not replay compact items when message_end becomes cumulative", async () => {
    const h = setup();
    const items = [
      { id: "item-a", text: "Alpha" },
      { id: "item-b", text: "Beta" },
    ];
    const base = createOpenAiResponsesPartial({
      text: "",
      id: "item-a",
      signaturePhase: "final_answer",
    });
    h.emit({ type: "message_start", message: base });
    for (const [contentIndex, item] of items.entries()) {
      const partial = createOpenAiResponsesPartial({ ...item, signaturePhase: "final_answer" });
      for (const type of ["text_delta", "text_end"] as const) {
        h.emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type,
            contentIndex,
            ...(type === "text_delta" ? { delta: item.text } : { content: item.text }),
            partial,
          },
        });
      }
      await h.subscription.waitForPendingEvents();
      expect(h.texts()).toEqual(items.slice(0, contentIndex + 1).map(({ text }) => text));
    }
    const message = {
      ...base,
      content: items.map(({ text, id }) => block(text, id, "final_answer")),
    };
    for (let repeat = 0; repeat < 2; repeat++) {
      h.emit({ type: "message_end", message });
      await h.subscription.waitForPendingEvents();
      expect(h.texts()).toEqual(["Alpha", "Beta"]);
      expect(h.onBlockReply).toHaveBeenCalledTimes(2);
    }
  });

  it.each([
    {
      name: "unfinished reasoning before a queued phase update",
      prefix: "<think>private",
      queuedDeltas: [" reasoning", " remains private"],
      recoveryPrefix: "</think>",
      audioAsVoice: false,
    },
    {
      name: "split unclosed inline tag examples",
      prefix: "Example: <thi",
      recoveryPrefix: "nk>literal.",
      expectedPrefix: "Example: <think>literal.",
      audioAsVoice: false,
    },
  ])(
    "preserves $name across late Responses phase updates",
    async ({ prefix, audioAsVoice, expectedPrefix = "", recoveryPrefix, queuedDeltas = [] }) => {
      const model: Model<"openai-responses"> = {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      };
      const answer = "Answer".repeat(32);
      const expected = expectedPrefix + answer;
      const queuedText = queuedDeltas.join("");
      let observedQueuedText = "";
      const rawProcessed = createDeferred();
      const reanchorProcessed = createDeferred();
      const phaseProcessed = createDeferred();
      const onPartialReply = vi.fn();
      const { emit, subscription, onBlockReply } = setup({
        onPartialReply,
        blockReplyChunking: { minChars: 64, maxChars: 128, breakPreference: "paragraph" },
      });
      async function* wireEvents() {
        yield {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_answer", role: "assistant", content: [] },
        };
        yield { type: "response.output_text.delta", output_index: 0, delta: prefix };
        await rawProcessed.promise;
        yield {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "reasoning", id: "rs_reanchor", summary: [] },
        };
        await reanchorProcessed.promise;
        const text = prefix + queuedDeltas.join("") + recoveryPrefix + answer;
        const finalItem = {
          type: "message",
          id: "msg_answer",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        if (queuedDeltas.length > 0) {
          for (const delta of queuedDeltas) {
            yield { type: "response.output_text.delta", output_index: 0, delta };
          }
          yield { type: "response.output_item.done", output_index: 0, item: finalItem };
          phaseProcessed.resolve();
        }
        yield {
          type: "response.completed",
          response: {
            id: "resp_phase_recovery",
            status: "completed",
            output: [finalItem, { type: "reasoning", id: "rs_reanchor", summary: [] }],
          },
        };
      }
      const output = createResponsesAssistantOutput(model);
      const response = new AssistantMessageEventStream();
      response.push({ type: "start", partial: output });
      const producing = processResponsesStream(wireEvents(), output, response, model).then(
        () => {
          response.push({ type: "done", reason: "stop", message: output });
          response.end();
        },
        (error: unknown) => {
          response.end({ ...output, stopReason: "error", errorMessage: String(error) });
          throw error;
        },
      );
      const running = runAgentLoop(
        [{ role: "user", content: "Give the answer.", timestamp: 1 }],
        { systemPrompt: "", messages: [] },
        {
          model,
          convertToLlm: (messages) =>
            messages.filter(
              (message): message is Message =>
                message.role === "user" ||
                message.role === "assistant" ||
                message.role === "toolResult",
            ),
        },
        async (event) => {
          emit(event);
          await subscription.waitForPendingEvents();
          if (event.type !== "message_update") {
            return;
          }
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta" && update.delta === prefix) {
            expect(onBlockReply).not.toHaveBeenCalled();
            rawProcessed.resolve();
          }
          if (update.type === "thinking_start") {
            reanchorProcessed.resolve();
            if (queuedDeltas.length > 0) {
              await phaseProcessed.promise;
            }
          }
          if (update.type === "text_delta" && queuedText && queuedText.includes(update.delta)) {
            observedQueuedText += update.delta;
            expect(onPartialReply).not.toHaveBeenCalled();
          }
        },
        undefined,
        () => response,
      );
      try {
        await Promise.all([producing, running]);
        await subscription.waitForPendingEvents();
        expect(observedQueuedText).toBe(queuedText);
        expect(extractTextPayloads(onBlockReply.mock.calls).join("")).toBe(expected);
        expect(subscription.assistantTexts.join("")).toBe(expected);
        expect(onBlockReply.mock.calls[0]?.[0].audioAsVoice ?? false).toBe(audioAsVoice);
      } finally {
        rawProcessed.resolve();
        reanchorProcessed.resolve();
        phaseProcessed.resolve();
        await Promise.allSettled([producing, running]);
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { name: "late completions phase", api: "openai-completions", suppressLiveStreamOutput: false },
    {
      name: "suppressed Responses stream",
      api: "openai-responses",
      suppressLiveStreamOutput: true,
    },
  ] as const)(
    "delivers all undelivered final blocks after $name",
    async ({ api, suppressLiveStreamOutput }) => {
      const onAgentEvent = vi.fn();
      const h = setup({ onAgentEvent, suppressLiveStreamOutput });
      const base = { ...createOpenAiResponsesPartial({ text: "", id: "answer-0" }), api };
      const texts = ["First", "Second"];
      h.emit({ type: "message_start", message: base });
      for (const [contentIndex, delta] of texts.entries()) {
        const partial = {
          ...base,
          content: texts
            .slice(0, contentIndex + 1)
            .map((text, index) =>
              block(text, `answer-${index}`, suppressLiveStreamOutput ? "final_answer" : undefined),
            ),
        };
        h.emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "text_delta", contentIndex, delta, partial },
        });
        await h.subscription.waitForPendingEvents();
        expect(h.onBlockReply).not.toHaveBeenCalled();
        expect(h.subscription.assistantTexts).toEqual([]);
      }
      if (suppressLiveStreamOutput) {
        expect(onAgentEvent).not.toHaveBeenCalled();
      }
      h.emit({
        type: "message_end",
        message: {
          ...base,
          content: texts.map((text, index) => block(text, `answer-${index}`, "final_answer")),
        },
      });
      await h.subscription.waitForPendingEvents();
      expectSingle(h, "First\nSecond");
      expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
        stream: "assistant",
        data: { text: "First\nSecond" },
      });
    },
  );
});

describe("terminal visible replies", () => {
  it("prepares an outer final envelope from standalone message-tool JSON", async () => {
    const h = setup({ blockReplyBreak: "message_end", enforceFinalTag: true });
    const encoded = JSON.stringify({
      name: "message",
      arguments: { action: "send", target: "test-target", message: "Visible reply." },
    });
    const message = { ...textAssistant(`<final>${encoded}</final>`), api: "openai-completions" };
    h.emit({ type: "message_start", message });
    h.emit({ type: "message_end", message });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(["Visible reply."]);
    for (const [payload] of h.onBlockReply.mock.calls) {
      expect(payload.replyToId).toBeUndefined();
      expect(payload.replyToCurrent).toBeFalsy();
      expect(payload.replyToTag).toBeFalsy();
    }
  });

  it("preserves indented code in Responses replies", async () => {
    const text = "    const value = 1;\n    use(value);";
    const code = "const value = 1;\nuse(value);\n";
    const onAgentEvent = vi.fn();
    const h = setup({
      onAgentEvent,
      blockReplyBreak: "message_end",
      blockReplyChunking: { minChars: 64, maxChars: 128, breakPreference: "paragraph" },
    });
    const message = createOpenAiResponsesPartial({
      text,
      id: "item-final-code",
      signaturePhase: "final_answer",
    });
    h.emit({ type: "message_start", message: { ...message, content: [] } });
    {
      let accumulatedText = "";
      for (const delta of ["    ", "const value = 1;\n", "    use(value);"]) {
        accumulatedText += delta;
        const partial = {
          ...message,
          content: message.content.map((part) => ({ ...part, text: accumulatedText })),
        };
        h.emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
        });
        await h.subscription.waitForPendingEvents();
      }
    }
    h.emit({ type: "message_end", message });
    await h.subscription.waitForPendingEvents();
    for (const texts of [h.texts(), h.subscription.assistantTexts]) {
      expect
        .soft(texts.map((payload) => markdownToIR(payload)))
        .toMatchObject([
          { text: code, styles: [{ start: 0, end: code.length, style: "code_block" }] },
        ]);
    }
    expect
      .soft(
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => event.data.text),
      )
      .toEqual(["    const value = 1;", text]);
  });

  it("does not replay a source range assembled from multiple streamed chunks", async () => {
    const h = setup({ blockReplyChunking: { minChars: 1, maxChars: 4 } });
    const text = "aaaaaaaaaaaa";
    h.emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit: h.emit, delta: text });
    h.emit({ type: "message_end", message: textAssistant(text) });
    expect(h.texts()).toEqual(["aaaa", "aaaa", "aaaa"]);
    emitAssistantTextEnd({ emit: h.emit, content: text });
    await Promise.resolve();
    expect(h.texts()).toEqual(["aaaa", "aaaa", "aaaa"]);
  });

  it("delivers the full final text when it extends suppressed commentary", async () => {
    const h = setup();
    h.emit({ type: "message_start", message: { role: "assistant" } });
    responsePair(h, "Hello", "item_commentary", "commentary");
    await Promise.resolve();
    expect(h.onBlockReply).not.toHaveBeenCalled();
    responsePair(h, "Hello world", "item_final", "final_answer", " world");
    await Promise.resolve();
    expectSingle(h, "Hello world");
  });

  it("delivers the final answer at message_end after streamed commentary", async () => {
    const h = setup();
    h.emit({ type: "message_start", message: { role: "assistant" } });
    responsePair(h, "Working...", "item_commentary", "commentary");
    await Promise.resolve();
    h.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          block("Working...", "item_commentary", "commentary"),
          block("Done.", "item_final", "final_answer"),
        ],
      },
    });
    expectSingle(h, "Done.");
  });
});

type TestAssistant = Pick<AssistantMessage, "role" | "content"> &
  Partial<Pick<AssistantMessage, "api" | "stopReason" | "openclawDelivery">> & {
    phase?: "commentary" | "final_answer";
  };
function subscribe(options: Options = {}) {
  const harness = createSubscribedSessionHarness({ runId: "run", ...options });
  onTestFinished(() => harness.subscription.unsubscribe());
  return harness;
}
function blockHarness(options: Options = {}) {
  const onBlockReply = vi.fn();
  return { ...subscribe({ onBlockReply, blockReplyBreak: "text_end", ...options }), onBlockReply };
}
function emitProviderUpdate(
  emit: ReturnType<typeof subscribe>["emit"],
  message: TestAssistant,
  event: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: TestAssistant;
  },
) {
  emit({ type: "message_update", message, assistantMessageEvent: event });
}
function textMessage(
  text: string,
  api: "anthropic-messages" | "openai-completions",
): TestAssistant {
  return { ...textAssistant(text), api };
}
function textBlock(text: string, id: string, phase: "commentary" | "final_answer") {
  return { ...createOpenAiResponsesTextBlock({ text, id, phase }), type: "text" as const };
}
function toolBlock(id: string, name: string) {
  return { type: "toolCall" as const, id, name, arguments: {} };
}
function postedText(reply: ReturnType<typeof vi.fn>) {
  return reply.mock.calls.map(([payload]) => payload?.text ?? "").join(" ");
}

describe("reasoning delivery", () => {
  it.each(["text_end", "message_end"] as const)(
    "delivers completed native reasoning before %s answers without repeating it at message_end",
    (blockReplyBreak) => {
      const { emit, onBlockReply } = blockHarness({ blockReplyBreak, reasoningMode: "on" });
      const thinking = { type: "thinking" as const, thinking: "Because it helps" };
      const message: TestAssistant = { role: "assistant", content: [thinking] };
      emit({ type: "message_start", message });
      emitProviderUpdate(emit, message, {
        type: "thinking_end",
        content: thinking.thinking,
        contentIndex: 0,
      });
      message.content = [thinking, { type: "text", text: "Final answer" }];
      emitProviderUpdate(emit, message, {
        type: "text_delta",
        delta: "Final answer",
        contentIndex: 1,
      });
      emitProviderUpdate(emit, message, {
        type: "text_end",
        content: "Final answer",
        contentIndex: 1,
      });
      emit({ type: "message_end", message });
      expect(onBlockReply.mock.calls.map(([payload]) => payload)).toEqual([
        expect.objectContaining({ text: "Because it helps", isReasoning: true }),
        expect.objectContaining({ text: "Final answer" }),
      ]);
    },
  );

  it.each(["text_end", "message_end"] as const)(
    "orders terminal-only reasoning before %s answer blocks",
    (blockReplyBreak) => {
      const { emit, onBlockReply } = blockHarness({ blockReplyBreak, reasoningMode: "on" });
      emit({ type: "message_end", message: createReasoningFinalAnswerMessage() });
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
        "Because it helps",
        "Final answer",
      ]);
    },
  );

  it("keeps reasoning deduplicated across distinct Responses answer items", () => {
    const h = setup({ reasoningMode: "on" });
    const thinking = { type: "thinking", thinking: "Because it helps" };
    const message = { role: "assistant", content: [thinking] };
    h.emit({ type: "message_start", message });
    h.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_end", content: thinking.thinking },
    });
    responsePair(h, "Alpha", "item_alpha");
    responsePair(h, "Beta", "item_beta");
    h.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [thinking, block("Alpha", "item_alpha"), block("Beta", "item_beta")],
      },
    });
    expect(h.texts()).toEqual(["Because it helps", "Alpha", "Beta"]);
  });

  it("does not repeat accumulated reasoning and resets delivery for the next message", () => {
    const { emit, onBlockReply } = blockHarness({ reasoningMode: "on" });
    for (const answer of ["First answer", "Next answer"]) {
      const message: TestAssistant = { role: "assistant", content: [] };
      emit({ type: "message_start", message });
      for (const thought of ["First thought", "Second thought"]) {
        message.content.push({ type: "thinking", thinking: thought });
        emitProviderUpdate(emit, message, {
          type: "thinking_end",
          content: thought,
          contentIndex: message.content.length - 1,
        });
      }
      message.content.push({ type: "text", text: answer });
      emitProviderUpdate(emit, message, {
        type: "text_end",
        content: answer,
        contentIndex: message.content.length - 1,
      });
      emit({ type: "message_end", message });
    }
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "First thought",
      "Second thought",
      "First answer",
      "First thought",
      "Second thought",
      "Next answer",
    ]);
  });

  it.each(THINKING_TAG_CASES.filter(({ tag }) => tag === "mm:think"))(
    "promotes $tag reasoning to thinking blocks before delivering the answer",
    ({ open, close }) => {
      const { emit, onBlockReply } = blockHarness({
        blockReplyBreak: "message_end",
        reasoningMode: "on",
      });
      const message: TestAssistant = textAssistant(
        `${open}\nBecause it helps\n${close}\n\nFinal answer`,
      );
      emit({ type: "message_end", message });
      expect(onBlockReply).toHaveBeenCalledTimes(2);
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
        "Because it helps",
        "Final answer",
      ]);
      expect(message.content).toEqual([
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ]);
    },
  );

  it("keeps draft partials private with reasoning on and no block replies", () => {
    const onPartialReply = vi.fn();
    const { emit, subscription } = subscribe({ reasoningMode: "on", onPartialReply });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Draft " });
    emitAssistantTextDelta({ emit, delta: "reply" });
    expect(onPartialReply).not.toHaveBeenCalled();
    emit({ type: "message_end", message: createReasoningFinalAnswerMessage() });
    emitAssistantTextEnd({ emit, content: "Draft reply" });
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(subscription.assistantTexts).toEqual(["Final answer"]);
  });
});

describe("terminal provider phase resolution", () => {
  it.each([
    {
      api: "anthropic-messages",
      narration: "Let me check the files before I answer. ",
      toolName: "bash",
      args: { command: "ls" },
    },
    {
      api: "openai-completions",
      narration: "Importing ORDER-1234 into the tracker… ",
      toolName: "import_order",
      args: { id: "ORDER-1234" },
    },
  ] as const)(
    "withholds $api pre-tool narration from durable replies",
    ({ api, narration, toolName, args }) => {
      const { emit, onBlockReply } = blockHarness({
        blockReplyChunking: { minChars: 4, maxChars: 200 },
      });
      emit({ type: "message_start", message: textMessage("", api) });
      emitProviderUpdate(emit, textMessage(narration, api), {
        type: "text_delta",
        delta: narration,
      });
      emit({ type: "tool_execution_start", toolName, toolCallId: "tool-1", args });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          api,
          stopReason: "toolUse",
          content: [
            textBlock(narration, "commentary-0", "commentary"),
            toolBlock("tool-1", toolName),
          ],
        },
      });
      expect(postedText(onBlockReply)).not.toContain(
        api === "anthropic-messages" ? "Let me check the files" : "Importing ORDER-1234",
      );
    },
  );

  it("withholds reasoning-associated completions text until terminal resolution", () => {
    const onPartialReply = vi.fn();
    const { emit, onBlockReply } = blockHarness({ onPartialReply, blockReplyBreak: "message_end" });
    const message: TestAssistant = {
      ...textMessage("Interim text.", "openai-completions"),
      openclawDelivery: { textPhaseRequiresTerminal: true },
    };
    emit({ type: "message_start", message });
    emitProviderUpdate(emit, message, {
      type: "text_delta",
      contentIndex: 0,
      delta: "Interim text.",
    });
    expect(onPartialReply).not.toHaveBeenCalled();
    const terminal = {
      ...message,
      content: [
        textBlock("Interim text.", "commentary-0", "commentary"),
        textBlock("Final text.", "final-0", "final_answer"),
      ],
    };
    emitProviderUpdate(emit, terminal, {
      type: "text_delta",
      contentIndex: 1,
      delta: "Final text.",
    });
    emit({ type: "message_end", message: terminal });
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(postedText(onBlockReply)).toBe("Final text.");
  });
});
