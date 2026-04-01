import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads reasoning-on fallback", () => {
  it("includes fallback answer when reasoning is on and assistantTexts has earlier content", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        { type: "thinking", thinking: "Because it helps" },
        { type: "text", text: "Final answer" },
      ],
    });

    // assistantTexts has earlier block-reply text but NOT the final answer
    const payloads = buildPayloads({
      assistantTexts: ["Earlier block reply text"],
      lastAssistant,
      reasoningLevel: "on",
    });

    const texts = payloads.map((p) => p.text);
    // The earlier text should still be present
    expect(texts).toContain("Earlier block reply text");
    // The final answer must be appended from fallback
    expect(texts).toContain("Final answer");
  });

  it("does not duplicate when assistantTexts already contains the final answer", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Final answer" }],
    });

    const payloads = buildPayloads({
      assistantTexts: ["Final answer"],
      lastAssistant,
      reasoningLevel: "on",
    });

    const answerPayloads = payloads.filter((p) => !p.isReasoning);
    // Should not duplicate the answer
    const answerTexts = answerPayloads.map((p) => p.text).filter(Boolean);
    const finalCount = answerTexts.filter((t) => t === "Final answer").length;
    expect(finalCount).toBe(1);
  });

  it("does not append fallback when reasoning is off", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Final answer" }],
    });

    const payloads = buildPayloads({
      assistantTexts: ["Earlier block reply text"],
      lastAssistant,
      reasoningLevel: "off",
    });

    const texts = payloads.map((p) => p.text);
    // Should only contain assistantTexts, not the fallback
    expect(texts).toContain("Earlier block reply text");
    expect(texts).not.toContain("Final answer");
  });

  it("does not duplicate when multi-chunk assistantTexts already covers the full answer", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Part 1\nPart 2" }],
    });

    // Block-reply chunking split the answer into two entries.
    // Concatenating them reproduces the fallback text.
    const payloads = buildPayloads({
      assistantTexts: ["Part 1", "Part 2"],
      lastAssistant,
      reasoningLevel: "on",
    });

    const answerPayloads = payloads.filter((p) => !p.isReasoning);
    const answerTexts = answerPayloads.map((p) => p.text).filter(Boolean);
    // Each chunk should appear once; the combined fallback must NOT be appended
    expect(answerTexts).toEqual(["Part 1", "Part 2"]);
  });

  it("appends fallback when multi-chunk assistantTexts differ from the final answer", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Completely different final answer" }],
    });

    const payloads = buildPayloads({
      assistantTexts: ["Part 1", "Part 2"],
      lastAssistant,
      reasoningLevel: "on",
    });

    const answerPayloads = payloads.filter((p) => !p.isReasoning);
    const answerTexts = answerPayloads.map((p) => p.text).filter(Boolean);
    // Chunks are preserved and the different fallback is appended
    expect(answerTexts).toEqual(["Part 1", "Part 2", "Completely different final answer"]);
  });

  it("does not duplicate when assistantTexts contains earlier messages plus current message chunks", () => {
    const lastAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Part 1\nPart 2" }],
    });

    // Simulates multi-turn run where assistantTexts accumulated across messages:
    // - entries 0-1 belong to a previous assistant message (tool call confirmation)
    // - entries 2-3 belong to the current final answer (baseline = 2)
    const payloads = buildPayloads({
      assistantTexts: ["Tool result acknowledged", "Calling next tool...", "Part 1", "Part 2"],
      assistantTextBaseline: 2,
      lastAssistant,
      reasoningLevel: "on",
    });

    const answerPayloads = payloads.filter((p) => !p.isReasoning);
    const answerTexts = answerPayloads.map((p) => p.text).filter(Boolean);
    // All four entries should be present; the combined fallback must NOT be appended
    expect(answerTexts).toEqual([
      "Tool result acknowledged",
      "Calling next tool...",
      "Part 1",
      "Part 2",
    ]);
  });
});

describe("buildEmbeddedRunPayloads tool-error warnings", () => {
  function expectNoPayloads(params: Parameters<typeof buildPayloads>[0]) {
    const payloads = buildPayloads(params);
    expect(payloads).toHaveLength(0);
  }

  it("suppresses exec tool errors when verbose mode is off", () => {
    expectNoPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "off",
    });
  });

  it("shows exec tool errors when verbose mode is on", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "exec", error: "command failed" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Exec",
      detail: "command failed",
    });
  });

  it("keeps non-exec mutating tool failures visible", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      absentDetail: "permission denied",
    });
  });

  it.each([
    {
      name: "includes details for mutating tool failures when verbose is on",
      verboseLevel: "on" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
    {
      name: "includes details for mutating tool failures when verbose is full",
      verboseLevel: "full" as const,
      detail: "permission denied",
      absentDetail: undefined,
    },
  ])("$name", ({ verboseLevel, detail, absentDetail }) => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel,
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail,
      absentDetail,
    });
  });

  it.each([
    {
      name: "default relay failure",
      lastToolError: { toolName: "sessions_send", error: "delivery timeout" },
    },
    {
      name: "mutating relay failure",
      lastToolError: {
        toolName: "sessions_send",
        error: "delivery timeout",
        mutatingAction: true,
      },
    },
  ])("suppresses sessions_send errors for $name", ({ lastToolError }) => {
    expectNoPayloads({
      lastToolError,
      verboseLevel: "on",
    });
  });

  it("suppresses assistant text when a deterministic exec approval prompt was already delivered", () => {
    expectNoPayloads({
      assistantTexts: ["Approval is needed. Please run /approve abc allow-once"],
      didSendDeterministicApprovalPrompt: true,
    });
  });

  it("suppresses JSON NO_REPLY assistant payloads", () => {
    expectNoPayloads({
      assistantTexts: ['{"action":"NO_REPLY"}'],
    });
  });
});
