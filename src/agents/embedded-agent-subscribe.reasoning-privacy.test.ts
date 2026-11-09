import { describe, expect, it, onTestFinished, vi } from "vitest";
import { onAgentEventForRun } from "../infra/agent-events.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

const privacyCases = [
  ...["reasoning", "internal", "antml:reasoning", "mm:reasoning"].map((tag) => ({
    name: tag,
    deltas: [
      "Before ",
      "<",
      tag.slice(0, 2),
      tag.slice(2) + ">",
      "PRIVATE_MARKER",
      "</" + tag + ">",
      " After",
    ],
  })),
  {
    name: "nested same-name tags",
    deltas: ["Before <think>outer<think>inner</think>", "PRIVATE_MARKER", "</think> After"],
  },
  {
    name: "nested mixed private tags",
    deltas: [
      "Before <internal>outer<reasoning>inner</reasoning>",
      "PRIVATE_MARKER",
      "</internal> After",
    ],
  },
  {
    name: "quoted attribute containing a split closing bracket",
    deltas: ["Before <reasoning note='a>", "b'>PRIVATE_MARKER", "</reasoning> After"],
  },
  {
    name: "split self-closing attributed tag",
    deltas: ["Before <reasoning note='a>", "b' /", "> After"],
  },
];

function createPrivacyHarness(reasoningMode: "stream" | "on" = "stream") {
  const publicPayloads: string[] = [];
  const capture = (payload: unknown) => {
    const serialized = JSON.stringify(payload);
    if (serialized !== undefined) {
      publicPayloads.push(serialized);
    }
  };
  const onPartialReply = vi.fn(capture);
  const onBlockReply = vi.fn(capture);
  const onReasoningStream = vi.fn(capture);
  const onReasoningEnd = vi.fn();
  const busEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const removeListener = onAgentEventForRun("reasoning-privacy", (event) => {
    capture(event);
    busEvents.push(event);
  });
  const harness = createSubscribedSessionHarness({
    runId: "reasoning-privacy",
    reasoningMode,
    onPartialReply,
    onBlockReply,
    onReasoningStream,
    onReasoningEnd,
    onAgentEvent: capture,
    blockReplyBreak: "text_end",
  });
  onTestFinished(async () => {
    harness.subscription.unsubscribe();
    await harness.subscription.waitForPendingEvents();
    removeListener();
  });
  harness.emit({ type: "message_start", message: { role: "assistant" } });
  return {
    ...harness,
    onReasoningStream,
    onReasoningEnd,
    publicPayloads,
    busEvents,
    partials: () => extractTextPayloads(onPartialReply.mock.calls),
    blocks: () => extractTextPayloads(onBlockReply.mock.calls),
  };
}

describe("streamed reasoning tag privacy", () => {
  it.each(privacyCases)(
    "withholds $name through partial and block delivery",
    async ({ deltas }) => {
      const h = createPrivacyHarness();
      for (const delta of deltas) {
        emitAssistantTextDelta({ emit: h.emit, delta });
        await h.subscription.waitForPendingEvents();
        for (const text of [...h.partials(), ...h.blocks()]) {
          expect(text).not.toContain("PRIVATE_MARKER");
          expect(text).not.toContain("<");
        }
      }
      const content = deltas.join("");
      emitAssistantTextEnd({ emit: h.emit, content });
      h.emit({ type: "message_end", message: textAssistant(content) });
      await h.subscription.waitForPendingEvents();
      expect(h.partials().at(-1)).toBe("Before  After");
      expect(h.blocks().join("")).toBe("Before  After");
      for (const text of [...h.partials(), ...h.blocks()]) {
        expect(text).not.toContain("PRIVATE_MARKER");
      }
    },
  );

  it("never renders internal text as enabled reasoning", async () => {
    const h = createPrivacyHarness();
    emitAssistantTextDelta({
      emit: h.emit,
      delta: "Before <internal>PRIVATE_MARKER</internal> After",
    });
    await h.subscription.waitForPendingEvents();
    expect(h.partials()).toEqual(["Before  After"]);
    expect(h.onReasoningStream).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "inline tags whose quote must not consume a later real tag",
      deltas: [
        "Use `<reasoning note='literal>` and `<internal>literal</internal>`.",
        " <reasoning>PRIVATE_MARKER</reasoning> After",
      ],
      expected: "Use `<reasoning note='literal>` and `<internal>literal</internal>`.  After",
    },
    {
      name: "fence and attributed tag split across chunks",
      deltas: [
        "~~~xml\n<reason",
        "ing note='literal'>public</reasoning>\n~~",
        "~\n\n<internal>PRIVATE_MARKER</internal>After",
      ],
      expected: "~~~xml\n<reasoning note='literal'>public</reasoning>\n~~~\n\nAfter",
    },
  ])("preserves public code: $name", async ({ deltas, expected }) => {
    const h = createPrivacyHarness();
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit: h.emit, delta });
      await h.subscription.waitForPendingEvents();
      for (const text of [...h.partials(), ...h.blocks()]) {
        expect(text).not.toContain("PRIVATE_MARKER");
      }
    }
    const content = deltas.join("");
    emitAssistantTextEnd({ emit: h.emit, content });
    h.emit({ type: "message_end", message: textAssistant(content) });
    await h.subscription.waitForPendingEvents();
    expect(h.partials().at(-1)).toBe(expected);
    expect(h.blocks().join("")).toBe(expected);
  });
});

const nestedPrivateCases = [
  {
    name: "internal inside think",
    deltas: [
      "<think>",
      "<inter",
      "nal note='a>",
      "b'>PRIVATE_MARKER",
      "</internal>",
      "</think>Answer",
    ],
  },
  {
    name: "think inside internal",
    deltas: ["<internal>", "<think>PRIVATE_MARKER", "</think>", "</internal>Answer"],
  },
];

const streamedPrivateCases = [
  ...nestedPrivateCases,
  {
    name: "split inline-code ownership",
    deltas: ["<internal>`", "</internal><think>PRIVATE_MARKER", "`</internal>Answer"],
  },
];

describe.each(["stream", "on"] as const)("nested private reasoning (%s)", (mode) => {
  it.each(streamedPrivateCases)(
    "withholds $name on every streamed and settled lane",
    async ({ deltas }) => {
      const h = createPrivacyHarness(mode);
      const assertPrivate = () => {
        for (const payload of h.publicPayloads) {
          expect(payload).not.toContain("PRIVATE_MARKER");
        }
      };
      for (const delta of deltas) {
        emitAssistantTextDelta({ emit: h.emit, delta });
        await h.subscription.waitForPendingEvents();
        assertPrivate();
      }
      expect(h.partials().at(-1)).toBe("Answer");
      expect(h.onReasoningStream).not.toHaveBeenCalled();
      expect(h.busEvents.filter((event) => event.stream === "thinking")).toEqual([]);
      const content = deltas.join("");
      emitAssistantTextEnd({ emit: h.emit, content });
      await h.subscription.waitForPendingEvents();
      assertPrivate();
      h.emit({ type: "message_end", message: textAssistant(content) });
      await h.subscription.waitForPendingEvents();
      assertPrivate();
      expect(h.blocks().join("")).toBe("Answer");
      const ended = h.onReasoningEnd.mock.calls.length;
      emitAssistantTextEnd({ emit: h.emit, content });
      await h.subscription.waitForPendingEvents();
      assertPrivate();
      expect(h.onReasoningEnd).toHaveBeenCalledTimes(ended);

      h.emit({ type: "message_start", message: { role: "assistant" } });
      emitAssistantTextDelta({ emit: h.emit, delta: "<think>Fresh reasoning</think>Next" });
      h.emit({ type: "message_end", message: textAssistant("<think>Fresh reasoning</think>Next") });
      await h.subscription.waitForPendingEvents();
      assertPrivate();
      expect(
        h.busEvents.some(
          (event) => event.stream === "thinking" && event.data.text === "Fresh reasoning",
        ),
      ).toBe(true);
      expect(h.partials().at(-1)).toBe("Next");
    },
  );

  it.each(nestedPrivateCases)(
    "withholds terminal-only $name during promotion",
    async ({ deltas }) => {
      const h = createPrivacyHarness(mode);
      h.emit({ type: "message_end", message: textAssistant(deltas.join("")) });
      await h.subscription.waitForPendingEvents();
      for (const payload of h.publicPayloads) {
        expect(payload).not.toContain("PRIVATE_MARKER");
      }
      expect(h.blocks().join("")).toBe("Answer");
      expect(h.onReasoningStream).not.toHaveBeenCalled();
      expect(h.busEvents.filter((event) => event.stream === "thinking")).toEqual([]);
    },
  );
});

describe("legacy reasoning remains live and code-aware", () => {
  it("streams safe legacy reasoning before terminal settlement", async () => {
    const h = createPrivacyHarness();
    emitAssistantTextDelta({ emit: h.emit, delta: "<think>Visible reasoning" });
    await h.subscription.waitForPendingEvents();
    expect(extractTextPayloads(h.onReasoningStream.mock.calls)).toEqual(["Visible reasoning"]);
    expect(
      h.busEvents.some(
        (event) => event.stream === "thinking" && event.data.delta === "Visible reasoning",
      ),
    ).toBe(true);
    emitAssistantTextDelta({ emit: h.emit, delta: " continues</think>Answer" });
    h.emit({
      type: "message_end",
      message: textAssistant("<think>Visible reasoning continues</think>Answer"),
    });
    await h.subscription.waitForPendingEvents();
    expect(extractTextPayloads(h.onReasoningStream.mock.calls).at(-1)).toBe(
      "Visible reasoning continues",
    );
    expect(h.onReasoningEnd).toHaveBeenCalledTimes(1);
    expect(h.blocks().join("")).toBe("Answer");
  });

  it.each([
    { name: "inline quoted tag", reasoning: "Use `<think note='literal>`." },
    {
      name: "fenced private-tag literal",
      reasoning: "Example\n~~~xml\n<internal>PUBLIC_LITERAL</internal>\n~~~",
    },
  ])("preserves $name without exposing later private content", async ({ reasoning }) => {
    const h = createPrivacyHarness();
    const deltas = [`<think>${reasoning}\n`, "<internal>PRIVATE_MARKER</internal></think>Answer"];
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit: h.emit, delta });
      await h.subscription.waitForPendingEvents();
    }
    expect(extractTextPayloads(h.onReasoningStream.mock.calls)[0]).toBe(reasoning);
    h.emit({ type: "message_end", message: textAssistant(deltas.join("")) });
    await h.subscription.waitForPendingEvents();
    for (const payload of h.publicPayloads) {
      expect(payload).not.toContain("PRIVATE_MARKER");
    }
    expect(h.blocks().join("")).toBe("Answer");
  });
});
