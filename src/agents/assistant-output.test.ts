import { describe, expect, it } from "vitest";
import {
  createAssistantOutputIdState,
  extractAssistantOutputCandidates,
  extractAssistantOutputSegments,
  resolveAssistantFallbackMessageId,
  resetAssistantOutputMessageState,
} from "./assistant-output.js";

describe("assistant output extraction", () => {
  it("reads phase and signature ids from textSignature", () => {
    const message = {
      id: "msg-1",
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Step 1/3: checking status.",
          textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
        },
        {
          type: "text",
          text: " Final summary.",
          textSignature: JSON.stringify({ id: "sig-2", phase: "final_answer" }),
        },
      ],
    };

    const segments = extractAssistantOutputSegments(message as never);

    expect(segments).toEqual([
      {
        segmentId: "sig-1",
        text: "Step 1/3: checking status.",
        phase: "commentary",
      },
      {
        segmentId: "sig-2",
        text: "Final summary.",
        phase: "final_answer",
      },
    ]);
  });

  it("accepts raw textSignature ids", () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Hello", textSignature: "msg_test" }],
    };

    const segments = extractAssistantOutputSegments(message as never);

    expect(segments).toEqual([
      {
        segmentId: "msg_test",
        text: "Hello",
      },
    ]);
  });

  it("strips model control tokens from assistant output segments", () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "<|assistant|>Hello<|end|>" }],
    };

    const segments = extractAssistantOutputSegments(message as never);

    expect(segments).toEqual([
      expect.objectContaining({
        text: "Hello",
      }),
    ]);
  });

  it("does not rewrite successful assistant text when stale error metadata is present", () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      errorMessage: "background tool failed",
      content: [{ type: "text", text: "Payment required errors should be handled by the API." }],
    };

    const segments = extractAssistantOutputSegments(message as never);

    expect(segments).toEqual([
      expect.objectContaining({
        text: "Payment required errors should be handled by the API.",
      }),
    ]);
  });

  it("splits signed text segments across non-text boundaries", () => {
    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Step 1.",
          textSignature: JSON.stringify({ id: "sig-1", phase: "commentary" }),
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
        {
          type: "text",
          text: "Step 2.",
          textSignature: JSON.stringify({ id: "sig-2", phase: "commentary" }),
        },
      ],
    };

    const segments = extractAssistantOutputSegments(message as never);

    expect(segments).toEqual([
      {
        segmentId: "sig-1",
        text: "Step 1.",
        phase: "commentary",
      },
      {
        segmentId: "sig-2",
        text: "Step 2.",
        phase: "commentary",
      },
    ]);
  });

  it("marks a terminal commentary fragment as still growing", () => {
    const message = {
      id: "assistant-stream",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Step 2/3: running lint.",
          textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
        },
      ],
    };

    const segments = extractAssistantOutputCandidates(message as never);

    expect(segments).toEqual([
      {
        segmentId: "sig-stream",
        text: "Step 2/3: running lint.",
        phase: "commentary",
        isTerminal: true,
      },
    ]);
  });

  it("marks a commentary fragment as deliverable once a later block closes it", () => {
    const message = {
      id: "assistant-stream",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Step 2/3: running lint.",
          textSignature: JSON.stringify({ id: "sig-stream", phase: "commentary" }),
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const segments = extractAssistantOutputCandidates(message as never);

    expect(segments).toEqual([
      {
        segmentId: "sig-stream",
        text: "Step 2/3: running lint.",
        phase: "commentary",
        isTerminal: false,
      },
    ]);
  });
});

describe("assistant output fallback ids", () => {
  it("reuses the same fallback id inside one assistant turn and rotates after reset", () => {
    const state = createAssistantOutputIdState();

    const firstMessageId = resolveAssistantFallbackMessageId(state);
    const repeatedMessageId = resolveAssistantFallbackMessageId(state);
    resetAssistantOutputMessageState(state);
    const secondMessageId = resolveAssistantFallbackMessageId(state);

    expect(firstMessageId).toBe("stream-0");
    expect(repeatedMessageId).toBe(firstMessageId);
    expect(secondMessageId).toBe("stream-1");
  });

  it("uses caller-scoped fallback ids for unsigned repeated assistant turns", () => {
    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Still working...",
          phase: "commentary",
        },
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "exec",
          args: "{}",
        },
      ],
    };

    const firstSegments = extractAssistantOutputSegments(message as never, {
      fallbackMessageStableId: "stream-0",
    });
    const secondSegments = extractAssistantOutputSegments(message as never, {
      fallbackMessageStableId: "stream-1",
    });

    expect(firstSegments[0]?.segmentId).toBe("assistant:stream-0:segment:0");
    expect(secondSegments[0]?.segmentId).toBe("assistant:stream-1:segment:0");
    expect(firstSegments[0]?.segmentId).not.toBe(secondSegments[0]?.segmentId);
  });
});
