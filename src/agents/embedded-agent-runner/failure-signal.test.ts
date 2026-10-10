// Coverage for classifying embedded-run failure signals from tool metadata.
import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunFailureSignal } from "./failure-signal.js";

describe("resolveEmbeddedRunFailureSignal", () => {
  it("does not mark non-cron runs", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "user",
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toBeUndefined();
  });

  it("does not mark non-exec validation errors as execution denials", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "browser",
          errorCode: "INVALID_REQUEST",
          error: "INVALID_REQUEST: url required",
        },
      }),
    ).toBeUndefined();
  });

  it("does not mark tool output that merely mentions host denial tokens", () => {
    // Match structured error metadata, not arbitrary command output that happens
    // to mention a denial code.
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "The fetched page says SYSTEM_RUN_DENIED in its troubleshooting section.",
        },
      }),
    ).toBeUndefined();
  });

  it("uses a structured code even when the message is omitted", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
        },
      }),
    ).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED",
      fatalForCron: true,
    });
  });
});
