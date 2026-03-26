import { describe, expect, it } from "vitest";
import { buildFailureReport } from "./failure-report.js";

describe("buildFailureReport", () => {
  it("returns verification failure when verify checks fail", () => {
    const report = buildFailureReport({
      generatedAt: Date.now(),
      verifyReport: {
        status: "failed",
        strategy: "command-tool",
        generatedAt: Date.now(),
        checksRun: 2,
        checksPassed: 1,
        checksFailed: 1,
        entries: [],
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "failed",
        category: "verification",
        source: "verify-runner",
        code: "verify_failed",
        verifyChecksRun: 2,
        verifyChecksFailed: 1,
      }),
    );
  });

  it("returns tool failure when the last tool errored", () => {
    const report = buildFailureReport({
      generatedAt: Date.now(),
      lastToolError: {
        toolName: "browser",
        meta: "open page",
        error: "tab not found",
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "failed",
        category: "tool",
        source: "tool-result",
        code: "tool_error",
        toolName: "browser",
      }),
    );
  });

  it("returns none when there is no structured failure signal", () => {
    const report = buildFailureReport({
      generatedAt: Date.now(),
      verifyReport: {
        status: "passed",
        strategy: "command-tool",
        generatedAt: Date.now(),
        checksRun: 1,
        checksPassed: 1,
        checksFailed: 0,
        entries: [],
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        status: "none",
        category: "none",
        code: "none",
      }),
    );
  });
});
