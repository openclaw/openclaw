import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession", () => {
  it("includes canvas action metadata in tool summaries", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-canvas-tool",
      verboseLevel: "on",
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "canvas",
      toolCallId: "tool-canvas-1",
      args: { action: "a2ui_push", jsonlPath: "/tmp/a2ui.jsonl" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
    const payload = onToolResult.mock.calls[0][0];
    expect(payload.text).toContain("🖼️");
    expect(payload.text).toContain("Canvas");
    expect(payload.text).toContain("/tmp/a2ui.jsonl");
  });
  it("skips tool summaries when shouldEmitToolResult is false", () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-off",
      shouldEmitToolResult: () => false,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: { path: "/tmp/b.txt" },
    });

    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("emits tool summaries when shouldEmitToolResult overrides verbose", async () => {
    const onToolResult = vi.fn();

    const toolHarness = createSubscribedSessionHarness({
      runId: "run-tool-override",
      verboseLevel: "off",
      shouldEmitToolResult: () => true,
      onToolResult,
    });

    toolHarness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-3",
      args: { path: "/tmp/c.txt" },
    });

    // Wait for async handler to complete
    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it("localizes and rate-limits tool summaries from agent defaults", async () => {
    vi.useFakeTimers();
    try {
      const onToolResult = vi.fn();

      const toolHarness = createSubscribedSessionHarness({
        runId: "run-localized-summary",
        verboseLevel: "on",
        config: {
          agents: {
            defaults: {
              toolSummaries: {
                locale: "zh-CN",
                minIntervalMs: 1000,
              },
            },
          },
        },
        onToolResult,
      });

      toolHarness.emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-summary-1",
        args: { path: "/tmp/first.txt" },
      });
      await Promise.resolve();

      toolHarness.emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-summary-2",
        args: { path: "/tmp/blocked.txt" },
      });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1000);
      toolHarness.emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-summary-3",
        args: { path: "/tmp/allowed.txt" },
      });
      await Promise.resolve();

      expect(onToolResult).toHaveBeenCalledTimes(2);
      expect(onToolResult.mock.calls[0][0].text).toContain("读文件");
      expect(onToolResult.mock.calls[0][0].text).toContain("/tmp/first.txt");
      expect(onToolResult.mock.calls[1][0].text).toContain("读文件");
      expect(onToolResult.mock.calls[1][0].text).toContain("/tmp/allowed.txt");
    } finally {
      vi.useRealTimers();
    }
  });
});
