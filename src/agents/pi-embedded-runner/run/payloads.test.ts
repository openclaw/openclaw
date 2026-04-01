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
