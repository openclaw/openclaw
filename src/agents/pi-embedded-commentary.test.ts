import { describe, expect, it } from "vitest";
import { encodeAssistantTextSignature } from "../shared/chat-message-content.js";
import {
  extractAssistantOutputCandidates,
  normalizeAssistantOutputSegmentId,
  resolveAssistantCommentaryDeltaText,
} from "./pi-embedded-commentary.js";

describe("pi embedded commentary output extraction", () => {
  it("extracts a signed commentary text block", () => {
    const segments = extractAssistantOutputCandidates({
      role: "assistant",
      id: "msg-1",
      content: [
        {
          type: "text",
          text: "Checking the logs",
          textSignature: encodeAssistantTextSignature({
            id: "sig-1",
            phase: "commentary",
          }),
        },
      ],
    });

    expect(segments).toEqual([
      {
        segmentId: "sig-1",
        text: "Checking the logs",
        phase: "commentary",
        isTerminal: true,
      },
    ]);
  });

  it("derives stable fallback segment ids for unsigned blocks", () => {
    const segments = extractAssistantOutputCandidates({
      role: "assistant",
      id: "msg-2",
      phase: "commentary",
      content: [
        { type: "text", text: "First " },
        { type: "text", text: "second" },
      ],
    });

    expect(segments).toEqual([
      {
        segmentId: "assistant:msg-2:segment:0",
        text: "First second",
        phase: "commentary",
        isTerminal: true,
      },
    ]);
  });

  it("groups repeated signed text blocks by id and phase", () => {
    const textSignature = encodeAssistantTextSignature({
      id: "sig-stream",
      phase: "commentary",
    });

    const segments = extractAssistantOutputCandidates({
      role: "assistant",
      content: [
        { type: "text", text: "Checking ", textSignature },
        { type: "text", text: "logs", textSignature },
      ],
    });

    expect(segments).toEqual([
      {
        segmentId: "sig-stream",
        text: "Checking logs",
        phase: "commentary",
        isTerminal: true,
      },
    ]);
  });

  it("keeps commentary and final answer phases separate", () => {
    const segments = extractAssistantOutputCandidates({
      role: "assistant",
      id: "msg-3",
      content: [
        {
          type: "text",
          text: "Checking",
          textSignature: encodeAssistantTextSignature({
            id: "sig-commentary",
            phase: "commentary",
          }),
        },
        {
          type: "text",
          text: "Done",
          textSignature: encodeAssistantTextSignature({
            id: "sig-final",
            phase: "final_answer",
          }),
        },
      ],
    });

    expect(segments.map(({ segmentId, phase, text }) => ({ segmentId, phase, text }))).toEqual([
      { segmentId: "sig-commentary", phase: "commentary", text: "Checking" },
      { segmentId: "sig-final", phase: "final_answer", text: "Done" },
    ]);
  });

  it("rejects unsafe segment ids before tracking", () => {
    expect(normalizeAssistantOutputSegmentId("")).toBeNull();
    expect(normalizeAssistantOutputSegmentId("x".repeat(129))).toBeNull();
    expect(normalizeAssistantOutputSegmentId("sig with spaces")).toBeNull();
    expect(normalizeAssistantOutputSegmentId("sig-1_2/path:ok")).toBe("sig-1_2/path:ok");
  });

  it("sanitizes thinking and tool-call text from segments", () => {
    const segments = extractAssistantOutputCandidates({
      role: "assistant",
      id: "msg-4",
      phase: "commentary",
      content: [
        {
          type: "text",
          text: "<think>private</think>Visible",
        },
      ],
    });

    expect(segments).toEqual([
      {
        segmentId: "assistant:msg-4:segment:0",
        text: "Visible",
        phase: "commentary",
        isTerminal: true,
      },
    ]);
  });

  it("does not slice by an unverifiable delivered length when the stored snapshot is truncated", () => {
    const deliveredPrefix = "a".repeat(8_000);
    const currentText = `${deliveredPrefix} changed before the stored full length.`;

    expect(
      resolveAssistantCommentaryDeltaText({
        currentText,
        deliveredText: deliveredPrefix,
        deliveredTextLength: 15_000,
      }),
    ).toBe(" changed before the stored full length.");
  });

  it("replays the full commentary text when even the stored delivered prefix no longer matches", () => {
    expect(
      resolveAssistantCommentaryDeltaText({
        currentText: "Rewritten commentary.",
        deliveredText: "Original",
        deliveredTextLength: 15_000,
      }),
    ).toBe("Rewritten commentary.");
  });
});
