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

  it("keeps non-exec mutating tool failures visible with truncated reason", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: "permission denied" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail: "— permission denied",
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

  it("includes truncated failure reason in non-verbose mode", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "edit", error: "Could not find exact text match" },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Edit",
      detail: "— Could not find exact text match",
    });
  });

  it("truncates long error reasons to 120 chars with ellipsis", () => {
    const longError = "A".repeat(200);
    const payloads = buildPayloads({
      lastToolError: { toolName: "write", error: longError },
      verboseLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("— " + "A".repeat(120) + "…");
  });

  it("uses only first line of multi-line error for truncated reason", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "write",
        error: "Primary error\nStack trace line 1\nStack trace line 2",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail: "— Primary error",
      absentDetail: "Stack trace",
    });
  });

  it("skips leading empty lines in multi-line error", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "write",
        error: "\n\nActual error message\nMore details",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail: "— Actual error message",
      absentDetail: "More details",
    });
  });

  it("scrubs filesystem paths from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "write",
        error:
          "Sandbox path escapes allowed mounts; cannot write: /home/openclaw/.sandbox/agent/file.txt",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail: "<path>",
      absentDetail: "/home/openclaw",
    });
  });

  it("scrubs session keys from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "session_status",
        error: "Session not found: agent:main:whatsapp:direct:+15555550123",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Session Status",
      detail: "<session>",
      absentDetail: "+15555550123",
    });
  });

  it("scrubs external-content wrappers from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "web_fetch",
        error: "Web fetch failed (500): <<<EXTERNAL_UNTRUSTED_CONTENT id=abc123>>> Some page text",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Web Fetch",
      detail: "Web fetch failed (500):",
      absentDetail: "EXTERNAL_UNTRUSTED",
    });
  });

  it("scrubs Windows drive-letter paths from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "read",
        error: "Sandbox FS error: C:\\Users\\agent\\file.txt not found",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Read",
      detail: "<path>",
      absentDetail: "C:\\Users",
    });
  });

  it("scrubs /workspace paths from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "write",
        error: "Failed boundary read for /workspace/project/src/index.ts",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Write",
      detail: "<path>",
      absentDetail: "/workspace/",
    });
  });

  it("scrubs Windows paths with spaces from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "read",
        error: "Sandbox FS error: C:\\Users\\Jane Doe\\Documents\\file.txt not accessible",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Read",
      detail: "<path>",
      absentDetail: "Jane Doe",
    });
  });

  it("scrubs signed URLs from non-verbose error reasons", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "pdf",
        error:
          "Expected PDF but got image/png: https://s3.amazonaws.com/bucket/file.pdf?X-Amz-Credential=AKIA1234&X-Amz-Signature=abc123",
      },
      verboseLevel: "off",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Pdf",
      detail: "<url>",
      absentDetail: "X-Amz-Credential",
    });
  });

  it("uses colon separator in verbose mode for full error details", () => {
    const payloads = buildPayloads({
      lastToolError: { toolName: "edit", error: "Could not find exact text match" },
      verboseLevel: "on",
    });

    expectSingleToolErrorPayload(payloads, {
      title: "Edit",
      detail: ": Could not find exact text match",
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
