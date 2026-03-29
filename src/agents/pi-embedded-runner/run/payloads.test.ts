import { describe, expect, it } from "vitest";
import { buildPayloads, expectSingleToolErrorPayload } from "./payloads.test-helpers.js";

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

  it("strips commentary that was actually delivered live", () => {
    const payloads = buildPayloads({
      assistantOutputs: [
        { segmentId: "c1", text: "Checking the repo state now.", phase: "commentary" },
        { segmentId: "f1", text: "Lint passed cleanly.", phase: "final_answer" },
      ],
      deliveredCommentarySegmentIds: ["c1"],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Lint passed cleanly.");
  });

  it("keeps commentary in the final reply when it was not sent live", () => {
    const payloads = buildPayloads({
      assistantOutputs: [
        { segmentId: "c1", text: "Checking the repo state now.", phase: "commentary" },
        { segmentId: "f1", text: "Lint passed cleanly.", phase: "final_answer" },
      ],
    });

    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.text)).toEqual([
      "Checking the repo state now.",
      "Lint passed cleanly.",
    ]);
  });

  it("does not fall back to assistantTexts when delivered commentary strips all assistant outputs", () => {
    expectNoPayloads({
      assistantOutputs: [
        { segmentId: "c1", text: "Checking the repo state now.", phase: "commentary" },
      ],
      deliveredCommentarySegmentIds: ["c1"],
      assistantTexts: ["Lint passed cleanly."],
    });
  });

  it("suppresses JSON NO_REPLY assistant payloads", () => {
    expectNoPayloads({
      assistantTexts: ['{"action":"NO_REPLY"}'],
    });
  });
});
