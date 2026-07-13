import { describe, expect, it } from "vitest";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";

describe("buildBlockedToolResult", () => {
  it("includes terminate: true for critical tool-loop vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason:
        "CRITICAL: Called exec with identical arguments and outcomes 10 times. Session blocked.",
      deniedReason: "tool-loop",
      toolCallId: "call-tl-1",
      runId: "run-1",
    });
    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "tool-loop",
    });
    // agent-core requires terminate: true on all finalized results to stop
    // the tool batch; without it the model retries the blocked tool.
    expect(result.terminate).toBe(true);
  });

  it("does not include terminate for plugin-before-tool-call vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Plugin before-tool-call denied",
      deniedReason: "plugin-before-tool-call",
      toolCallId: "call-pb-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-before-tool-call");
    expect(result.terminate).toBeUndefined();
  });

  it("does not include terminate for plugin-approval vetoes", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Plugin approval denied",
      deniedReason: "plugin-approval",
      toolCallId: "call-pa-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-approval");
    expect(result.terminate).toBeUndefined();
  });

  it("defaults deniedReason to plugin-before-tool-call when omitted", () => {
    resetAdjustedParamsByToolCallIdForTests();
    const result = buildBlockedToolResult({
      reason: "Default deny",
      toolCallId: "call-def-1",
      runId: "run-1",
    });
    expect(result.details.deniedReason).toBe("plugin-before-tool-call");
    expect(result.terminate).toBeUndefined();
  });
});
