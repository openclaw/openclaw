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

  it("appends recovery context when a mutating tool failure was recovered in the same turn", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "edit",
        error: "Found 2 occurrences, must be unique",
        mutatingAction: true,
        recovered: true,
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads[0]?.text).toContain("Edit");
    expect(payloads[0]?.text).toContain("failed");
    expect(payloads[0]?.text).toContain("recovered — retried successfully");
  });

  it("does not append recovery context when the mutating tool failure was not recovered", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "edit",
        error: "File not found",
        mutatingAction: true,
        recovered: false,
      },
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("Edit");
    expect(payloads[0]?.text).not.toContain("recovered");
  });

  it("includes error detail and recovery context together when verbose is on", () => {
    const payloads = buildPayloads({
      lastToolError: {
        toolName: "edit",
        error: "Found 2 occurrences, must be unique",
        mutatingAction: true,
        recovered: true,
      },
      verboseLevel: "on",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toContain("Found 2 occurrences, must be unique");
    expect(payloads[0]?.text).toContain("recovered — retried successfully");
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
