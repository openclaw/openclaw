// Coverage for classifying embedded-run failure signals from tool metadata.
import { describe, expect, it } from "vitest";
import {
  resolveEmbeddedRunFailureSignal,
  resolveEmbeddedRunSentinelSignal,
} from "./failure-signal.js";

describe("resolveEmbeddedRunFailureSignal", () => {
  it("classifies cron exec denials from tool error metadata", () => {
    // Cron execution denials are fatal because retrying the same scheduled turn
    // cannot collect interactive approval.
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          errorCode: "SYSTEM_RUN_DENIED",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "SYSTEM_RUN_DENIED: approval required",
      fatalForCron: true,
    });
  });

  it("classifies invalid request denials from tool error metadata", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "bash",
          errorCode: "INVALID_REQUEST",
          error: "INVALID_REQUEST: approval denied",
        },
      })?.code,
    ).toBe("INVALID_REQUEST");
  });

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

  it("does not mark ordinary tool failures as cron-denial failures", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "/bin/bash: line 1: python: command not found",
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

  it("does not infer approval-binding denials when the structured code is omitted", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        lastToolError: {
          toolName: "exec",
          error: "Approval cannot safely bind this interpreter/runtime command",
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

describe("resolveEmbeddedRunSentinelSignal", () => {
  it("returns fatal signal when cron final text ends with ===DONE_ERR===", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "cron",
      finalAssistantVisibleText: "===DONE_ERR=== vault delivery blocked",
    });
    expect(signal).toBeDefined();
    expect(signal?.kind).toBe("done_err_sentinel");
    expect(signal?.source).toBe("agent_text");
    expect(signal?.fatalForCron).toBe(true);
    expect(signal?.message).toContain("===DONE_ERR=== vault delivery blocked");
  });

  it("detects sentinel on the last line of multi-line text in cron runs", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "cron",
      finalAssistantVisibleText:
        "Checked all vaults.\nAll deliveries failed.\n===DONE_ERR=== vault delivery blocked",
    });
    expect(signal).toBeDefined();
    expect(signal?.fatalForCron).toBe(true);
    expect(signal?.message).toContain("===DONE_ERR=== vault delivery blocked");
  });

  it("does not trigger on ===DONE_ERR=== in middle of text", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "cron",
      finalAssistantVisibleText:
        "===DONE_ERR=== temp issue\nBut then recovery worked\nJob complete",
    });
    expect(signal).toBeUndefined();
  });

  it("does not trigger on ===DONE_OK=== sentinel", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "cron",
      finalAssistantVisibleText: "===DONE_OK=== vault updated successfully",
    });
    expect(signal).toBeUndefined();
  });

  it("does not trigger on normal text without sentinel in cron runs", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "cron",
      finalAssistantVisibleText: "All vaults updated successfully.\nProceeding with next step.",
    });
    expect(signal).toBeUndefined();
  });

  it("returns undefined when no finalAssistantVisibleText is provided", () => {
    const signal = resolveEmbeddedRunSentinelSignal({ trigger: "cron" });
    expect(signal).toBeUndefined();
  });

  it("does not mark non-cron runs even with sentinel in final text", () => {
    const signal = resolveEmbeddedRunSentinelSignal({
      trigger: "user",
      finalAssistantVisibleText: "===DONE_ERR=== vault delivery blocked",
    });
    expect(signal).toBeUndefined();
  });
});
