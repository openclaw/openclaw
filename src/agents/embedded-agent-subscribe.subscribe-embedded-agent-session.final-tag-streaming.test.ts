import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
  expectSingleAgentEventText,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

function subscribe(options: Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">) {
  const { emit, subscription } = createSubscribedSessionHarness({ runId: "run", ...options });
  onTestFinished(() => subscription.unsubscribe());
  return emit;
}

describe("streamed final tags", () => {
  it.each([
    {
      name: "ignores literal final tags inside fenced prefixes",
      deltas: ["```xml\n", "<final>literal</final>\n", "```\n<final>Answer</final>"],
      expected: "Answer",
      partial: false,
    },
    {
      name: "does not carry suppressed inline-code state into final text",
      deltas: ["draft `", "<final>Answer</final>"],
      expected: "Answer",
      partial: true,
    },
    {
      name: "closes hidden reasoning fences split across deltas",
      deltas: ["<think>\n```ts\nconst hidden = true;\n``", "`\n</think><final>Answer</final>"],
      expected: "Answer",
      partial: true,
    },
    {
      name: "strips nested final tags after suppressed fenced prefixes",
      deltas: ["```xml\n", "```\n<final>Answer <final>literal</final></final>"],
      expected: "Answer literal",
      partial: false,
    },
  ])("$name", ({ deltas, expected, partial }) => {
    const reply = vi.fn();
    const emit = subscribe({
      enforceFinalTag: true,
      ...(partial ? { onPartialReply: reply } : { onAgentEvent: reply }),
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit, delta });
    }
    const payloads = partial
      ? reply.mock.calls.map(([p]) => p)
      : extractAgentEventPayloads(reply.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(expected);
  });

  it.each([
    {
      name: "self-closing final closer",
      deltas: ["<final data-model='gemma'>Visible<final data-model='x' />hidden"],
    },
    {
      name: "leading self-closing final opener",
      deltas: ["<final data-model=openrouter/google/gemini/>Visible"],
    },
    {
      name: "split attributed final opener",
      deltas: ["<final data-model=openrouter/google/ge", "mma>Visible</final>"],
    },
  ])("preserves enforced content with a $name", ({ deltas }) => {
    const onPartialReply = vi.fn();
    const emit = subscribe({ enforceFinalTag: true, onPartialReply });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit, delta });
    }
    expect(
      onPartialReply.mock.calls
        .map(([p]) => p.delta)
        .filter((delta) => typeof delta === "string")
        .join(""),
    ).toBe("Visible");
  });

  it("strips split final tags without remnants or replacement events", () => {
    const onAgentEvent = vi.fn();
    const emit = subscribe({ onAgentEvent });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
      emitAssistantTextDelta({ emit, delta });
    }
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    const text = payloads.map((payload) => payload.delta).join("");
    expect(text).toBe("Title\nLine one\nLine two");
    expect(text).not.toContain("<");
    expect(text).not.toContain("final>");
    expect(payloads.some((payload) => payload.replace)).toBe(false);
  });

  it("does not treat custom or malformed tags as enforced final blocks", () => {
    const onPartialReply = vi.fn();
    const emit = subscribe({ enforceFinalTag: true, onPartialReply });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "<final-result>hidden" });
    emitAssistantTextDelta({ emit, delta: '<final reason="a>b">also hidden' });
    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("keeps trailing tag prefixes when message_end drains chunked text_end replies", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: { minChars: 1, maxChars: 200 },
    });
    onTestFinished(() => subscription.unsubscribe());
    const text = "Answer ends with <fi";
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: text });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: textAssistant(text) });
    await Promise.resolve();
    expect(onBlockReply.mock.calls.map(([payload]) => payload?.text)).toEqual([text]);
  });

  it("preserves literal trailing tag-prefix text in message_end fallback", () => {
    const onAgentEvent = vi.fn();
    const emit = subscribe({ onAgentEvent });
    emitMessageStartAndEndForAssistantText({ emit, text: "Answer ends with <" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Answer ends with <");
  });
});
