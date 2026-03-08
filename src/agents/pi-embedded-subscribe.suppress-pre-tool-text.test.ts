import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

/**
 * Tests for the suppressPreToolText feature.
 *
 * The feature splices intermediate assistant texts (e.g. "Lass mich nachschauen...")
 * produced during tool-use turns, keeping only the final answer turn.
 *
 * Implementation lives in finalizeAssistantTexts() which is a closure inside
 * subscribeEmbeddedPiSession(). We can't call it directly, so we test the
 * splice logic in isolation.
 */
describe("suppressPreToolText splice logic", () => {
  /**
   * Simulates the splice behavior from finalizeAssistantTexts:
   * When stopReason is "toolUse" and suppressPreToolText is enabled (and not verbose),
   * remove texts added since baseline.
   */
  function simulateFinalizeWithSplice(params: {
    assistantTexts: string[];
    baseline: number;
    stopReason?: string;
    suppressPreToolText: boolean;
    verboseLevel: "off" | "on" | "full";
  }): { assistantTexts: string[]; newBaseline: number } {
    const texts = [...params.assistantTexts];
    const isVerbose = params.verboseLevel !== "off";

    if (params.stopReason === "toolUse" && params.suppressPreToolText && !isVerbose) {
      texts.splice(params.baseline);
    }

    return { assistantTexts: texts, newBaseline: texts.length };
  }

  it('splices texts since baseline when stopReason="toolUse" + suppressPreToolText=true', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["previous answer", "Lass mich nachschauen..."],
      baseline: 1, // "Lass mich nachschauen..." was added since baseline
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["previous answer"]);
  });

  it('does NOT splice when stopReason="stop" (final answer preserved)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["previous answer", "Here is the final answer"],
      baseline: 1,
      stopReason: "stop",
      suppressPreToolText: true,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["previous answer", "Here is the final answer"]);
  });

  it('does NOT splice when verbose="on" (debug mode)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "on",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it('does NOT splice when verbose="full" (debug mode)', () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "full",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it("does NOT splice when suppressPreToolText=false (feature disabled)", () => {
    const result = simulateFinalizeWithSplice({
      assistantTexts: ["Lass mich nachschauen..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: false,
      verboseLevel: "off",
    });

    expect(result.assistantTexts).toEqual(["Lass mich nachschauen..."]);
  });

  it("multi-turn: intermediate tool-use texts removed, final turn texts preserved", () => {
    // Simulate a multi-turn conversation:
    // Turn 1: agent says "Let me check..." then uses a tool → splice at baseline=0
    const turn1 = simulateFinalizeWithSplice({
      assistantTexts: ["Let me check..."],
      baseline: 0,
      stopReason: "toolUse",
      suppressPreToolText: true,
      verboseLevel: "off",
    });
    expect(turn1.assistantTexts).toEqual([]);
    expect(turn1.newBaseline).toBe(0);

    // Turn 2: agent says "Based on the results, here is your answer" → stop
    const turn2Texts = [...turn1.assistantTexts, "Based on the results, here is your answer"];
    const turn2 = simulateFinalizeWithSplice({
      assistantTexts: turn2Texts,
      baseline: turn1.newBaseline,
      stopReason: "stop",
      suppressPreToolText: true,
      verboseLevel: "off",
    });
    expect(turn2.assistantTexts).toEqual(["Based on the results, here is your answer"]);
  });
});

/**
 * Streaming-aware tests: verify that onBlockReply is NOT called during streaming
 * for tool-use turns when suppressPreToolText is active, and IS called for final answers.
 */
describe("suppressPreToolText streaming (onBlockReply buffering)", () => {
  function createSession() {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };
    return {
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      fire: (evt: unknown) => handler?.(evt),
    };
  }

  function simulateTextStream(fire: (evt: unknown) => void, text: string) {
    fire({ type: "message_start", message: { role: "assistant" } });
    fire({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    fire({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_end" },
    });
  }

  function endMessage(fire: (evt: unknown) => void, text: string, stopReason: string) {
    fire({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason,
      } as AssistantMessage,
    });
  }

  it("tool-use turn: onBlockReply NOT called when suppressPreToolText=true", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      suppressPreToolText: true,
    });

    simulateTextStream(fire, "Lass mich nachschauen...");
    endMessage(fire, "Lass mich nachschauen...", "toolUse");

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("final answer turn: onBlockReply IS called (buffered replies flushed)", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      suppressPreToolText: true,
    });

    simulateTextStream(fire, "Here is your answer.");
    endMessage(fire, "Here is your answer.", "stop");

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Here is your answer." }),
    );
  });

  it("multi-turn: tool-use buffers discarded, final answer buffers flushed", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      suppressPreToolText: true,
    });

    // Turn 1: intermediate narration → toolUse
    simulateTextStream(fire, "Let me check...");
    endMessage(fire, "Let me check...", "toolUse");
    expect(onBlockReply).not.toHaveBeenCalled();

    // Turn 2: final answer → stop
    simulateTextStream(fire, "The result is 42.");
    endMessage(fire, "The result is 42.", "stop");
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "The result is 42." }),
    );
  });

  it("suppressPreToolText=false: onBlockReply called immediately (no buffering)", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      suppressPreToolText: false,
    });

    simulateTextStream(fire, "Lass mich nachschauen...");
    // onBlockReply should have been called BEFORE message_end (during streaming)
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    endMessage(fire, "Lass mich nachschauen...", "toolUse");
    // Still 1 call — message_end deduplicates
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("verbose mode: onBlockReply called immediately (suppression disabled at flush)", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      suppressPreToolText: true,
      verboseLevel: "on",
    });

    simulateTextStream(fire, "Lass mich nachschauen...");
    endMessage(fire, "Lass mich nachschauen...", "toolUse");

    // In verbose mode, buffered replies are flushed even on toolUse
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("message_end break: tool-use text discarded when suppressPreToolText=true", () => {
    const { session, fire } = createSession();
    const onBlockReply = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "message_end",
      suppressPreToolText: true,
    });

    fire({ type: "message_start", message: { role: "assistant" } });
    fire({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Checking now..." },
    });
    endMessage(fire, "Checking now...", "toolUse");

    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
