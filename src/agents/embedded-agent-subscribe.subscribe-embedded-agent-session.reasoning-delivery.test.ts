import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  THINKING_TAG_CASES,
  createReasoningFinalAnswerMessage,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { createOpenAiResponsesTextBlock } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
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
function update(
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
  it("does not emit native reasoning when thinking is disabled", () => {
    const { emit, onBlockReply } = blockHarness({
      blockReplyBreak: "message_end",
      reasoningMode: "on",
      thinkingLevel: "off",
    });
    emit({ type: "message_end", message: createReasoningFinalAnswerMessage() });
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0]?.[0].text).toBe("Final answer");
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

describe("commentary preambles", () => {
  it("preserves current aggregate commentary without Responses item boundaries", async () => {
    const onAgentEvent = vi.fn();
    const { emit, subscription } = subscribe({ onAgentEvent });
    const message: TestAssistant = {
      role: "assistant",
      api: "anthropic-messages",
      phase: "commentary",
      content: [...textAssistant("First.").content, ...textAssistant("Second.").content],
    };
    emit({ type: "message_start", message });
    update(emit, message, { type: "toolcall_start", contentIndex: 2, partial: message });
    const completed = {
      ...message,
      content: [...textAssistant("First.").content, ...textAssistant("Second. Updated.").content],
    };
    update(emit, completed, { type: "toolcall_start", contentIndex: 2, partial: completed });
    emit({ type: "message_end", message: completed });
    await subscription.waitForPendingEvents();
    expect(onAgentEvent.mock.calls.map(([event]) => event)).toEqual(
      [
        ["update", "First. Second."],
        ["update", "First. Second. Updated."],
        ["end", "First. Second. Updated."],
      ].map(([phase, progressText], index) =>
        Object.assign(
          {
            stream: "item",
            data: { kind: "preamble", title: "Preamble", phase, progressText },
          },
          index === 0 ? { transcriptStart: null } : {},
        ),
      ),
    );
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
      update(emit, textMessage(narration, api), { type: "text_delta", delta: narration });
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

  it("delivers a non-tool Anthropic answer in full", async () => {
    const { emit, onBlockReply, subscription } = blockHarness();
    const answer = "Here is the full answer.";
    emit({ type: "message_start", message: textMessage("", "anthropic-messages") });
    update(emit, textMessage(answer, "anthropic-messages"), { type: "text_delta", delta: answer });
    update(emit, textMessage(answer, "anthropic-messages"), { type: "text_end", contentIndex: 0 });
    emit({ type: "message_end", message: textMessage(answer, "anthropic-messages") });
    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalled();
    expect(postedText(onBlockReply)).toContain(answer);
  });

  it("withholds reasoning-associated completions text until terminal resolution", () => {
    const onPartialReply = vi.fn();
    const { emit, onBlockReply } = blockHarness({ onPartialReply, blockReplyBreak: "message_end" });
    const message: TestAssistant = {
      ...textMessage("Interim text.", "openai-completions"),
      openclawDelivery: { textPhaseRequiresTerminal: true },
    };
    emit({ type: "message_start", message });
    update(emit, message, { type: "text_delta", contentIndex: 0, delta: "Interim text." });
    expect(onPartialReply).not.toHaveBeenCalled();
    const terminal = {
      ...message,
      content: [
        textBlock("Interim text.", "commentary-0", "commentary"),
        textBlock("Final text.", "final-0", "final_answer"),
      ],
    };
    update(emit, terminal, { type: "text_delta", contentIndex: 1, delta: "Final text." });
    emit({ type: "message_end", message: terminal });
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(postedText(onBlockReply)).toBe("Final text.");
  });

  it("delivers permanently unphased completions text in prefix-before-suffix order", async () => {
    const onPartialReply = vi.fn();
    const { emit, onBlockReply, subscription } = blockHarness({
      onPartialReply,
      blockReplyChunking: { minChars: 4, maxChars: 200 },
    });
    emit({ type: "message_start", message: textMessage("", "openai-completions") });
    update(emit, textMessage("prefix ", "openai-completions"), {
      type: "text_delta",
      delta: "prefix ",
    });
    update(emit, textMessage("prefix suffix", "openai-completions"), {
      type: "text_end",
      contentIndex: 0,
      delta: "suffix",
    });
    emit({ type: "message_end", message: textMessage("prefix suffix", "openai-completions") });
    await subscription.waitForPendingEvents();
    expect(onBlockReply).toHaveBeenCalled();
    expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: "prefix" }));
    expect(postedText(onBlockReply)).toContain("prefix suffix");
  });

  it("withholds post-tool completions text through text_end classification", () => {
    const { emit, onBlockReply } = blockHarness();
    emit({ type: "message_start", message: textMessage("", "openai-completions") });
    update(emit, textMessage("post-tool commentary", "openai-completions"), {
      type: "text_end",
      contentIndex: 1,
      delta: "post-tool commentary",
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        api: "openai-completions",
        stopReason: "toolUse",
        content: [
          toolBlock("tool-1", "read"),
          textBlock("post-tool commentary", "commentary-0", "commentary"),
        ],
      },
    });
    expect(postedText(onBlockReply)).not.toContain("post-tool commentary");
  });
});
