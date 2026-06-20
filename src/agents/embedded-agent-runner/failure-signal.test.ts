// Coverage for classifying embedded-run failure signals from tool metadata.
import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunFailureSignal } from "./failure-signal.js";

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

  it("flags cron runs whose unknown-tool guard rewrote the assistant message (#92535)", () => {
    // The embedded runner's unknown-tool loop guard rewrites repeated calls
    // to an unavailable tool into a canned self-debug string. Without a fatal
    // failure signal, cron would announce that internal text to the user
    // channel instead of failing closed.
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        unknownToolLoopExhausted: { toolName: "process", rewriteCount: 11 },
      }),
    ).toEqual({
      kind: "tool_unavailable_exhausted",
      source: "runner",
      toolName: "process",
      code: "TOOL_UNAVAILABLE_EXHAUSTED",
      message: 'Cron run aborted: model exhausted retries on unavailable tool "process".',
      fatalForCron: true,
      bypassCronDelivery: true,
      rewriteCount: 11,
    });
  });

  it("omits rewriteCount when the guard report did not include one", () => {
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        unknownToolLoopExhausted: { toolName: "process" },
      }),
    ).toEqual({
      kind: "tool_unavailable_exhausted",
      source: "runner",
      toolName: "process",
      code: "TOOL_UNAVAILABLE_EXHAUSTED",
      message: 'Cron run aborted: model exhausted retries on unavailable tool "process".',
      fatalForCron: true,
      bypassCronDelivery: true,
    });
  });

  it("does not flag unknown-tool exhaustion for non-cron triggers", () => {
    // Interactive surfaces still want the self-repair text so the user can
    // see what the model tried and steer it; only unattended cron runs need
    // to suppress the canned string.
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "user",
        unknownToolLoopExhausted: { toolName: "process" },
      }),
    ).toBeUndefined();
  });

  it("ignores an unknown-tool report that has no tool name", () => {
    // Defensive guard: the rewrite always names a tool, but an empty report
    // must never silently fail closed without diagnostics.
    expect(
      resolveEmbeddedRunFailureSignal({
        trigger: "cron",
        unknownToolLoopExhausted: { toolName: "   " },
      }),
    ).toBeUndefined();
  });

  it("prefers a structured exec denial over a coincident unknown-tool report", () => {
    // If the model produces both signals in the same run (e.g. exec is denied
    // and the model then loops on an unavailable tool), the exec denial is
    // more diagnostic and should be reported.
    const signal = resolveEmbeddedRunFailureSignal({
      trigger: "cron",
      lastToolError: {
        toolName: "exec",
        errorCode: "SYSTEM_RUN_DENIED",
        error: "SYSTEM_RUN_DENIED: approval required",
      },
      unknownToolLoopExhausted: { toolName: "process", rewriteCount: 11 },
    });
    expect(signal?.kind).toBe("execution_denied");
    expect(signal?.code).toBe("SYSTEM_RUN_DENIED");
  });
});
