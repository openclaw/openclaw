import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "../../../auto-reply/reply/agent-runner-payloads.js";
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

  it("resolves [[reply_to_current]] using currentMessageId", () => {
    const payloads = buildPayloads({
      assistantTexts: ["[[reply_to_current]] quoted hello"],
      currentMessageId: "wa-msg-123",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("quoted hello");
    expect(payloads[0]?.replyToId).toBe("wa-msg-123");
    expect(payloads[0]?.replyToCurrent).toBe(true);
    expect(payloads[0]?.replyToTag).toBe(true);
  });

  it("does not stamp plain assistant replies with replyToCurrent", () => {
    const payloads = buildPayloads({
      assistantTexts: ["plain hello"],
      currentMessageId: "wa-msg-123",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("plain hello");
    expect(payloads[0]?.replyToCurrent).toBeUndefined();
    expect(payloads[0]?.replyToId).toBeUndefined();
  });

  it("buildReplyPayloads stamps replyToId from currentMessageId when replyToMode is all", async () => {
    const payloads = buildPayloads({
      assistantTexts: ["plain hello"],
      currentMessageId: "wa-msg-123",
    });

    const { replyPayloads } = await buildReplyPayloads({
      payloads,
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "all",
      replyToChannel: "whatsapp",
      currentMessageId: "wa-msg-123",
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.replyToId).toBe("wa-msg-123");
  });
});
