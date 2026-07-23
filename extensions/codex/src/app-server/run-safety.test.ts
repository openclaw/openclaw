import { describe, expect, it, vi } from "vitest";
import { createCodexRunSafetyController, formatCodexRunSafetyAlert } from "./run-safety.js";

describe("Codex run safety", () => {
  it("recreates the relay failure and stops before a third attempt", () => {
    const onTrip = vi.fn();
    const safety = createCodexRunSafetyController({
      onWarning: vi.fn(),
      onTrip,
    });

    safety.recordToolOutcome({
      toolName: "bash",
      toolCallId: "successful-call",
      arguments: { command: "git status -sb" },
      success: true,
    });
    safety.recordToolOutcome({
      toolName: " UPDATE_GOAL ",
      toolCallId: "call-1",
      arguments: { status: "BLOCKED", nested: { reason: " Relay down " } },
      success: false,
      error: " Native hook relay unavailable ",
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-2",
      arguments: { nested: { reason: "relay   down" }, status: "blocked" },
      success: false,
      error: "native hook   relay UNAVAILABLE",
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-3",
      arguments: { status: "blocked" },
      success: false,
      error: "Native hook relay unavailable",
    });

    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(safety.readTrip()).toMatchObject({
      kind: "identical_failure",
      attempts: 2,
      toolCallCount: 3,
      toolName: "update_goal",
      error: "native hook relay UNAVAILABLE",
      lastSuccessfulStep: "bash",
    });
  });

  it("does not combine different operations or errors", () => {
    const onTrip = vi.fn();
    const safety = createCodexRunSafetyController({
      onWarning: vi.fn(),
      onTrip,
    });

    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-1",
      arguments: { status: "blocked" },
      success: false,
      error: "relay unavailable",
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-2",
      arguments: { status: "complete" },
      success: false,
      error: "relay unavailable",
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-3",
      arguments: { status: "blocked" },
      success: false,
      error: "permission denied",
    });

    expect(onTrip).not.toHaveBeenCalled();
  });

  it("clears matching failure history after a successful operation", () => {
    const onTrip = vi.fn();
    const safety = createCodexRunSafetyController({
      onWarning: vi.fn(),
      onTrip,
    });
    const operation = {
      toolName: "update_goal",
      arguments: { status: "blocked" },
    };

    safety.recordToolOutcome({
      ...operation,
      toolCallId: "call-1",
      success: false,
      error: "relay unavailable",
    });
    safety.recordToolOutcome({ ...operation, toolCallId: "call-2", success: true });
    safety.recordToolOutcome({
      ...operation,
      toolCallId: "call-3",
      success: false,
      error: "relay unavailable",
    });

    expect(onTrip).not.toHaveBeenCalled();
  });

  it("warns at 25 tool calls and blocks the 50th call", () => {
    const onWarning = vi.fn();
    const onTrip = vi.fn();
    const safety = createCodexRunSafetyController({ onWarning, onTrip });

    for (let index = 1; index <= 49; index += 1) {
      expect(
        safety.recordToolCall({
          toolName: `tool-${index}`,
          toolCallId: `call-${index}`,
        }),
      ).toBe(true);
    }
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith({ toolCallCount: 25 });
    expect(
      safety.recordToolCall({
        toolName: "tool-50",
        toolCallId: "call-50",
      }),
    ).toBe(false);
    expect(
      safety.recordToolCall({
        toolName: "tool-51",
        toolCallId: "call-51",
      }),
    ).toBe(false);

    expect(onTrip).toHaveBeenCalledOnce();
    expect(safety.readTrip()).toMatchObject({
      kind: "tool_call_limit",
      attempts: 50,
      toolCallCount: 50,
    });
  });

  it("formats a complete redacted failure brief", () => {
    const safety = createCodexRunSafetyController({
      onWarning: vi.fn(),
      onTrip: vi.fn(),
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-1",
      arguments: { status: "blocked" },
      success: false,
      error: "Native hook relay unavailable token=secret-value",
    });
    safety.recordToolOutcome({
      toolName: "update_goal",
      toolCallId: "call-2",
      arguments: { status: "blocked" },
      success: false,
      error: "Native hook relay unavailable token=secret-value",
    });

    const text = formatCodexRunSafetyAlert({
      objective: "complete the current Codex turn",
      trip: safety.readTrip()!,
    });
    expect(text).toContain("Objective: complete the current Codex turn");
    expect(text).toContain("Attempts: 2");
    expect(text).toContain("Total tool calls: 2");
    expect(text).toContain("Possible partial writes or duplicates:");
    expect(text).toContain("Recommended recovery:");
    expect(text).toContain("Needed from you:");
    expect(text).not.toContain("secret-value");
  });
});
