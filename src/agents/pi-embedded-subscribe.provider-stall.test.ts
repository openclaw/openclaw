import { describe, expect, it, vi } from "vitest";
import {
  maybeWarnProviderStall,
  noteProviderProgress,
} from "./pi-embedded-subscribe.provider-stall.js";

type ProviderStallTestContext = Parameters<typeof noteProviderProgress>[0];

describe("provider stall diagnostics", () => {
  it("logs a warning for long google-gemini-cli stalls", () => {
    const warn = vi.fn();
    const ctx: ProviderStallTestContext = {
      params: {
        runId: "run-1",
        provider: "google-gemini-cli",
        modelId: "gemini-2.5-flash",
      },
      state: {},
      log: { warn },
    };

    noteProviderProgress(ctx, "tool_result", 1_000);
    maybeWarnProviderStall(ctx, {
      phase: "before_tool",
      toolName: "read",
      toolCallId: "tool-1",
      nowMs: 47_250,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("embedded run provider stall");
    expect(message).toContain("runId=run-1");
    expect(message).toContain("provider=google-gemini-cli");
    expect(message).toContain("model=gemini-2.5-flash");
    expect(message).toContain("gapMs=46250");
    expect(message).toContain("since=tool_result");
    expect(message).toContain("phase=before_tool");
    expect(message).toContain("tool=read");
    expect(message).toContain("toolCallId=tool-1");
  });

  it("does not warn below the stall threshold", () => {
    const warn = vi.fn();
    const ctx: ProviderStallTestContext = {
      params: {
        runId: "run-2",
        provider: "google-gemini-cli",
        modelId: "gemini-2.5-flash",
      },
      state: {},
      log: { warn },
    };

    noteProviderProgress(ctx, "agent_start", 10_000);
    maybeWarnProviderStall(ctx, {
      phase: "before_agent_end",
      nowMs: 54_999,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("advances the warning baseline so the same gap is not warned twice", () => {
    const warn = vi.fn();
    const ctx: ProviderStallTestContext = {
      params: {
        runId: "run-dup",
        provider: "google-gemini-cli",
        modelId: "gemini-2.5-flash",
      },
      state: {},
      log: { warn },
    };

    noteProviderProgress(ctx, "tool_result", 1_000);
    maybeWarnProviderStall(ctx, {
      phase: "before_tool",
      toolName: "read",
      toolCallId: "tool-dup",
      nowMs: 47_250,
    });
    maybeWarnProviderStall(ctx, {
      phase: "before_agent_end",
      nowMs: 90_000,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(ctx.state.lastProviderProgressAtMs).toBe(47_250);
    expect(ctx.state.lastProviderProgressPhase).toBe("stall_warning");
  });

  it("ignores non-google providers", () => {
    const warn = vi.fn();
    const ctx: ProviderStallTestContext = {
      params: {
        runId: "run-3",
        provider: "openai",
        modelId: "gpt-5",
      },
      state: {},
      log: { warn },
    };

    noteProviderProgress(ctx, "tool_result", 5_000);
    maybeWarnProviderStall(ctx, {
      phase: "before_tool",
      toolName: "read",
      toolCallId: "tool-2",
      nowMs: 100_000,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
