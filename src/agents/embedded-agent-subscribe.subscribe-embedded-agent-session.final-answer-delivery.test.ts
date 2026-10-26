import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "../../packages/ai/src/transports/openai-completions.test-support.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { createDeliveryHarness as setup } from "./embedded-agent-subscribe.delivery.test-support.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
  createReasoningFinalAnswerMessage,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
  createOpenAiResponsesTextEvent,
  type OpenAiResponsesTextEventPhase,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import {
  emitProviderUpdate,
  textMessage,
  toolBlock,
  type TestAssistant,
} from "./embedded-agent-subscribe.provider-events.test-support.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
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

function responseItem(id: string, text: string, annotations: unknown[] = []) {
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations }],
  };
}

function completedResponse(id: string, output: unknown[]) {
  return { type: "response.completed", response: { id, status: "completed", output } };
}

function streamResponses(
  model: Model<"openai-responses">,
  wireEvents: AsyncIterable<unknown>,
  prompt: string,
  onEvent: NonNullable<Parameters<typeof runAgentLoop>[3]>,
) {
  const output = createResponsesAssistantOutput(model);
  const response = new AssistantMessageEventStream();
  response.push({ type: "start", partial: output });
  const producing = processResponsesStream(wireEvents, output, response, model).then(
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
    [{ role: "user", content: prompt, timestamp: 1 }],
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
    onEvent,
    undefined,
    () => response,
  );
  return { output, producing, running };
}

describe("Responses final delivery", () => {
  it.each(["text_end", "message_end"] as const)(
    "retains the active reply scope when terminal citations enrich an earlier item (%s)",
    async (blockReplyBreak) => {
      const onAgentEvent = vi.fn();
      const onAssistantMessageStart = vi.fn();
      const h = setup({ onAgentEvent, onAssistantMessageStart, blockReplyBreak });
      const model: Model<"openai-responses"> = {
        ...makeCompletionsModel(),
        api: "openai-responses",
      };
      const first = responseItem("msg_alpha", "Alpha");
      const second = responseItem("msg_beta", "Beta");
      const citation = "[Source](https://example.com/source)";
      const secondDelivered = createDeferred();
      async function* wireEvents() {
        for (const [output_index, message] of [first, second].entries()) {
          yield {
            type: "response.output_item.added",
            output_index,
            item: { ...message, content: [] },
          };
          yield { type: "response.output_item.done", output_index, item: message };
        }
        await secondDelivered.promise;
        expect(h.texts()).toEqual(["Alpha", ...(blockReplyBreak === "text_end" ? ["Beta"] : [])]);
        yield completedResponse("resp_late_source", [
          responseItem("msg_alpha", "Alpha", [
            { type: "url_citation", url: "https://example.com/source", title: "Source" },
          ]),
          second,
        ]);
      }
      const { output, producing, running } = streamResponses(
        model,
        wireEvents(),
        "Answer with sources.",
        async (event) => {
          h.emit(event);
          await h.subscription.waitForPendingEvents();
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_end" &&
            event.assistantMessageEvent.contentIndex === 1
          ) {
            secondDelivered.resolve();
          }
        },
      );
      try {
        await Promise.all([producing, running]);
      } finally {
        secondDelivered.resolve();
        await Promise.allSettled([producing, running]);
      }
      await h.subscription.waitForPendingEvents();

      expect(onAssistantMessageStart).toHaveBeenCalledTimes(2);
      expect(h.texts()).toEqual(["Alpha", "Beta"]);
      expect(h.subscription.assistantTexts).toEqual(["Alpha", "Beta"]);
      expect(output.content).toMatchObject([
        { type: "text", text: `Alpha\n\n${citation}` },
        { type: "text", text: "Beta" },
      ]);
      // Already delivered blocks are immutable; the terminal display corrects their metadata.
      expect(
        onAgentEvent.mock.calls
          .filter(([event]) => event.stream === "assistant")
          .map(([event]) => [event.data.text, event.data.replace === true]),
      ).toEqual([
        ["Alpha", false],
        ["Alpha\nBeta", false],
        [`Alpha\n\n${citation}\nBeta`, true],
      ]);
    },
  );
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
    h.start(base);
    for (const [contentIndex, item] of items.entries()) {
      const partial = createOpenAiResponsesPartial({ ...item, signaturePhase: "final_answer" });
      for (const type of ["text_delta", "text_end"] as const) {
        h.update(partial, {
          type,
          contentIndex,
          ...(type === "text_delta" ? { delta: item.text } : { content: item.text }),
          partial,
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
      h.end(message);
      await h.flush(["Alpha", "Beta"], false, 2);
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
        ...makeCompletionsModel({ id: "gpt-5.5", name: "GPT-5.5" }),
        api: "openai-responses",
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
        const finalItem = responseItem("msg_answer", text);
        if (queuedDeltas.length > 0) {
          for (const delta of queuedDeltas) {
            yield { type: "response.output_text.delta", output_index: 0, delta };
          }
          yield { type: "response.output_item.done", output_index: 0, item: finalItem };
          phaseProcessed.resolve();
        }
        yield completedResponse("resp_phase_recovery", [
          finalItem,
          { type: "reasoning", id: "rs_reanchor", summary: [] },
        ]);
      }
      const { producing, running } = streamResponses(
        model,
        wireEvents(),
        "Give the answer.",
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

  it("delivers all undelivered final blocks after a suppressed Responses stream", async () => {
    const onAgentEvent = vi.fn();
    const h = setup({ onAgentEvent, suppressLiveStreamOutput: true });
    const base = createOpenAiResponsesPartial({ text: "", id: "answer-0" });
    const texts = ["First", "Second"];
    h.start(base);
    for (const [contentIndex, delta] of texts.entries()) {
      const partial = {
        ...base,
        content: texts
          .slice(0, contentIndex + 1)
          .map((text, index) => block(text, `answer-${index}`, "final_answer")),
      };
      h.update(partial, { type: "text_delta", contentIndex, delta, partial });
      await h.subscription.waitForPendingEvents();
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(h.subscription.assistantTexts).toEqual([]);
    }
    expect(onAgentEvent).not.toHaveBeenCalled();
    h.end({
      ...base,
      content: texts.map((text, index) => block(text, `answer-${index}`, "final_answer")),
    });
    await h.subscription.waitForPendingEvents();
    expectSingle(h, "First\nSecond");
    expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      stream: "assistant",
      data: { text: "First\nSecond" },
    });
  });
});

describe("terminal visible replies", () => {
  it("prepares an outer final envelope from standalone message-tool JSON", async () => {
    const h = setup({ blockReplyBreak: "message_end", enforceFinalTag: true });
    const encoded = JSON.stringify({
      name: "message",
      arguments: { action: "send", target: "test-target", message: "Visible reply." },
    });
    const message = { ...textAssistant(`<final>${encoded}</final>`), api: "openai-completions" };
    h.start(message);
    h.end(message);
    await h.flush(["Visible reply."]);
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
    h.start({ ...message, content: [] });
    {
      let accumulatedText = "";
      for (const delta of ["    ", "const value = 1;\n", "    use(value);"]) {
        accumulatedText += delta;
        const partial = {
          ...message,
          content: message.content.map((part) => ({ ...part, text: accumulatedText })),
        };
        h.update(partial, { type: "text_delta", contentIndex: 0, delta, partial });
        await h.subscription.waitForPendingEvents();
      }
    }
    h.end(message);
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
    h.start();
    emitAssistantTextDelta({ emit: h.emit, delta: text });
    h.end(textAssistant(text));
    expect(h.texts()).toEqual(["aaaa", "aaaa", "aaaa"]);
    emitAssistantTextEnd({ emit: h.emit, content: text });
    await Promise.resolve();
    expect(h.texts()).toEqual(["aaaa", "aaaa", "aaaa"]);
  });

  it("delivers the full final text when it extends suppressed commentary", async () => {
    const h = setup();
    h.start();
    responsePair(h, "Hello", "item_commentary", "commentary");
    await Promise.resolve();
    expect(h.onBlockReply).not.toHaveBeenCalled();
    responsePair(h, "Hello world", "item_final", "final_answer", " world");
    await Promise.resolve();
    expectSingle(h, "Hello world");
  });

  it("delivers the final answer at message_end after streamed commentary", async () => {
    const h = setup();
    h.start();
    responsePair(h, "Working...", "item_commentary", "commentary");
    await Promise.resolve();
    h.end({
      role: "assistant",
      content: [
        block("Working...", "item_commentary", "commentary"),
        block("Done.", "item_final", "final_answer"),
      ],
    });
    expectSingle(h, "Done.");
  });
});

function subscribe(options: Options = {}) {
  const harness = createSubscribedSessionHarness({ runId: "run", ...options });
  onTestFinished(() => harness.subscription.unsubscribe());
  return harness;
}
describe("reasoning delivery", () => {
  it("keeps reasoning deduplicated across distinct Responses answer items", () => {
    const h = setup({ reasoningMode: "on" });
    const thinking = { type: "thinking", thinking: "Because it helps" };
    const message = { role: "assistant", content: [thinking] };
    h.start(message);
    h.textUpdate(message, "thinking_end", thinking.thinking);
    responsePair(h, "Alpha", "item_alpha");
    responsePair(h, "Beta", "item_beta");
    h.end({
      role: "assistant",
      content: [thinking, block("Alpha", "item_alpha"), block("Beta", "item_beta")],
    });
    expect(h.texts()).toEqual(["Because it helps", "Alpha", "Beta"]);
  });

  it.each(["text_end", "message_end"] as const)(
    "orders and deduplicates native reasoning through %s and resets for the next message",
    (blockReplyBreak) => {
      const h = setup({ blockReplyBreak, reasoningMode: "on" });
      const thoughts =
        blockReplyBreak === "text_end" ? ["First thought", "Second thought"] : ["First thought"];
      for (const answer of ["First answer", "Next answer"]) {
        const message: TestAssistant = { role: "assistant", content: [] };
        h.start(message);
        for (const thought of thoughts) {
          message.content.push({ type: "thinking", thinking: thought });
          h.textUpdate(message, "thinking_end", thought, message.content.length - 1);
        }
        message.content.push({ type: "text", text: answer });
        h.textUpdate(message, "text_delta", answer, message.content.length - 1);
        h.textUpdate(message, "text_end", answer, message.content.length - 1);
        h.end(message);
      }
      expect(h.onBlockReply.mock.calls.map(([payload]) => payload)).toEqual(
        ["First answer", "Next answer"].flatMap((answer) =>
          thoughts
            .map((text) => expect.objectContaining({ text, isReasoning: true }))
            .concat(expect.objectContaining({ text: answer })),
        ),
      );
    },
  );

  it.each(["text_end", "message_end"] as const)(
    "promotes terminal reasoning and delivers it before %s answer blocks",
    (blockReplyBreak) => {
      const { emit, onBlockReply } = setup({
        blockReplyBreak,
        reasoningMode: "on",
      });
      const message: TestAssistant = textAssistant(
        "<mm:think>\nBecause it helps\n</mm:think>\n\nFinal answer",
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

describe("unphased provider text delivery", () => {
  it("streams unphased pre-tool narration once without retroactive phase changes", async () => {
    const api = "openai-completions";
    const narration = "Importing ORDER-1234 into the tracker… ";
    const toolName = "import_order";
    const args = { id: "ORDER-1234" };
    const { emit, subscription, onBlockReply } = setup({
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });
    emit({ type: "message_start", message: textMessage("", api) });
    emitProviderUpdate(emit, textMessage(narration, api), {
      type: "text_delta",
      delta: narration,
    });
    emitProviderUpdate(emit, textMessage(narration, api), {
      type: "text_end",
      content: narration,
    });
    await subscription.waitForPendingEvents();
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([narration.trimEnd()]);
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api,
        stopReason: "toolUse",
        content: [{ type: "text", text: narration }, toolBlock("tool-1", toolName)],
      },
    });
    emit({ type: "tool_execution_start", toolName, toolCallId: "tool-1", args });
    await subscription.waitForPendingEvents();
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([narration.trimEnd()]);
  });

  it.each([true, false])(
    "preserves completions text around reasoning (interleaved: %s)",
    async (interleaved) => {
      const onPartialReply = vi.fn();
      const { emit, subscription, onBlockReply } = setup({
        onPartialReply,
        blockReplyBreak: "message_end",
      });
      const model = makeCompletionsModel();
      const output = createAssistantOutput(model);
      async function* chunks() {
        if (interleaved) {
          yield makeCompletionsChunk({ reasoning_content: "First thought." });
        }
        yield makeCompletionsChunk({ content: "Initial text." });
        await subscription.waitForPendingEvents();
        expect(onPartialReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Initial text." }),
        );
        expect(onBlockReply).not.toHaveBeenCalled();
        yield makeCompletionsChunk({ reasoning_content: "Second thought." });
        if (interleaved) {
          yield makeCompletionsChunk({ content: "Final text." });
          await subscription.waitForPendingEvents();
          expect(onPartialReply.mock.calls.at(-1)?.[0].text).toContain("Final text.");
          expect(onBlockReply).not.toHaveBeenCalled();
        }
        yield makeCompletionsChunk({}, "stop");
      }
      emit({ type: "message_start", message: output });
      await processCompletionsStream(chunks(), output, model, {
        push(event) {
          emitProviderUpdate(emit, output, event);
        },
      });
      emit({ type: "message_end", message: output });
      await subscription.waitForPendingEvents();
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
        interleaved ? "Initial text.\nFinal text." : "Initial text.",
      ]);
    },
  );
});
