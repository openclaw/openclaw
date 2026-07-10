import { describe, expect, it } from "vitest";
import { validatePluginApprovalRequestParams } from "./index.js";

describe("plugin approval protocol validators", () => {
  it("accepts enriched approval descriptions up to 512 characters", () => {
    const request = {
      title: "Apply workspace skill proposal",
      description: "d".repeat(512),
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
    expect(validatePluginApprovalRequestParams({ ...request, description: "d".repeat(513) })).toBe(
      false,
    );
  });

  it("accepts nullable optional metadata the same as omitted metadata", () => {
    // Callers that normalize missing optional metadata to `null` (e.g. bridge
    // callers) must be accepted, matching the gateway handler which already
    // treats every optional field here as `string | null`. See issue #98403.
    const request = {
      title: "Run host shell command",
      description: "The agent wants to execute a sandboxed command.",
      pluginId: null,
      severity: null,
      toolName: null,
      toolCallId: null,
      allowedDecisions: null,
      agentId: null,
      sessionKey: null,
      turnSourceChannel: null,
      turnSourceTo: null,
      turnSourceAccountId: null,
      turnSourceThreadId: null,
      twoPhase: true,
    };

    expect(validatePluginApprovalRequestParams(request)).toBe(true);
  });

  it("accepts a single nullable optional field alongside present metadata", () => {
    expect(
      validatePluginApprovalRequestParams({
        title: "Approve file write",
        description: "Write to the workspace.",
        pluginId: null,
        toolName: "write_file",
      }),
    ).toBe(true);
  });

  it("still rejects unknown extra fields and non-null invalid values (surgical relaxation)", () => {
    const base = { title: "Approve file write", description: "Write to the workspace." };

    // additionalProperties: false is preserved — an unknown field is still rejected.
    expect(validatePluginApprovalRequestParams({ ...base, unknownField: "nope" })).toBe(false);

    // Only `null` was added as an alternative for optional metadata; a non-string
    // pluginId (e.g. a number) is still rejected.
    expect(validatePluginApprovalRequestParams({ ...base, pluginId: 123 })).toBe(false);
  });
});
