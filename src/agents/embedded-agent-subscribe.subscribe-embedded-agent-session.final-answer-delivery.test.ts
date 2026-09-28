import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
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
    {
      name: "split voice directives",
      prefix: "[[audio_as_",
      recoveryPrefix: "voice]]",
      audioAsVoice: true,
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
  it.each([
    {
      name: "decoded reasoning and reply controls",
      body: "<think>hidden [[reply_to:example-id]]</think>Visible reply.",
      expected: "Visible reply.",
    },
    {
      name: "an entirely hidden decoded body",
      body: "<think>hidden [[reply_to:example-id]]</think>",
      expected: "",
    },
    {
      name: "decoded final prose after commentary",
      body: "Before <think>literal tag text after",
      mixedPhases: true,
      expected: "Before <think>literal tag text after",
    },
    {
      name: "an outer final envelope",
      body: "Visible reply.",
      finalEnvelope: true,
      expected: "Visible reply.",
    },
  ])("prepares $name from standalone message-tool JSON", async (scenario) => {
    const h = setup({ blockReplyBreak: "message_end", enforceFinalTag: scenario.finalEnvelope });
    const encoded = JSON.stringify({
      name: "message",
      arguments: { action: "send", target: "test-target", message: scenario.body },
    }).replaceAll("<", "\\u003c");
    const message = {
      ...textAssistant(scenario.finalEnvelope ? `<final>${encoded}</final>` : encoded),
      api: "openai-completions",
      ...(scenario.mixedPhases
        ? {
            content: [
              block("Working...", "commentary", "commentary"),
              block(encoded, "answer", "final_answer"),
            ],
          }
        : {}),
    };
    h.emit({ type: "message_start", message });
    h.emit({ type: "message_end", message });
    await h.subscription.waitForPendingEvents();
    expect(h.texts()).toEqual(scenario.expected ? [scenario.expected] : []);
    for (const [payload] of h.onBlockReply.mock.calls) {
      expect(payload.replyToId).toBeUndefined();
      expect(payload.replyToCurrent).toBeFalsy();
      expect(payload.replyToTag).toBeFalsy();
    }
  });

  it.each(["google", "responses"] as const)(
    "preserves indented code in %s replies",
    async (provider) => {
      const text = "    const value = 1;\n    use(value);";
      const code = "const value = 1;\nuse(value);\n";
      const onAgentEvent = vi.fn();
      const h = setup({
        onAgentEvent,
        blockReplyBreak: "message_end",
        blockReplyChunking: { minChars: 64, maxChars: 128, breakPreference: "paragraph" },
      });
      const message =
        provider === "responses"
          ? createOpenAiResponsesPartial({
              text,
              id: "item-final-code",
              signaturePhase: "final_answer",
            })
          : {
              ...textAssistant(text),
              api: "google-generative-ai",
              provider: "google",
              model: "gemini-2.5-flash",
              stopReason: "stop" as const,
            };
      h.emit({ type: "message_start", message: { ...message, content: [] } });
      if (provider === "responses") {
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
        .toEqual(provider === "responses" ? ["    const value = 1;", text] : [text]);
    },
  );

  it("retains silent terminal evidence with text_end block replies", async () => {
    const h = setup({
      blockReplyChunking: { minChars: 64, maxChars: 128, breakPreference: "paragraph" },
    });
    h.emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit: h.emit, delta: "NO_REPLY" });
    emitAssistantTextEnd({ emit: h.emit, content: "NO_REPLY" });
    h.emit({ type: "message_end", message: textAssistant("NO_REPLY") });
    await h.subscription.waitForPendingEvents();
    expect(h.subscription.assistantTexts).toEqual(["NO_REPLY"]);
    expect(h.onBlockReply).not.toHaveBeenCalled();
  });

  it("recovers visible text when text_end delivered only silent NO_REPLY chunks", async () => {
    const h = setup();
    h.emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextEnd({ emit: h.emit, content: "NO_REPLY" });
    await Promise.resolve();
    expect(h.onBlockReply).not.toHaveBeenCalled();
    h.emit({ type: "message_end", message: textAssistant("Final visible reply.") });
    await h.subscription.waitForPendingEvents();
    expectSingle(h, "Final visible reply.");
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
