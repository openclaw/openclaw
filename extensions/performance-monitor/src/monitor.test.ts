// Performance Monitor tests cover monitor and diagnostic ingestion behavior.
import { describe, expect, it, vi } from "vitest";
import { createPerformanceMonitor, testApi as monitorTestApi } from "./monitor.js";
import { createPerformanceMonitorService, testApi as serviceTestApi } from "./service.js";

const trusted = Object.freeze({ trusted: true });

describe("performance-monitor monitor", () => {
  it("records per-plugin hook handler timing", () => {
    const monitor = createPerformanceMonitor();
    monitor.recordEvent({
      runId: "run-1",
      kind: "hook_handler",
      extensionId: "active-memory",
      hookName: "before_tool_call",
      durationMs: 18.5,
      outcome: "completed",
    });

    const trace = monitor.getRunTrace("run-1");
    expect(trace?.summary.hookHandlerCount).toBe(1);
    expect(trace?.summary.totalHookHandlerMs).toBe(18.5);
    expect(trace?.events[0]).toMatchObject({
      kind: "hook_handler",
      extensionId: "active-memory",
      hookName: "before_tool_call",
      durationMs: 18.5,
    });
  });

  it("records tool and llm calls with extension attribution", () => {
    const monitor = createPerformanceMonitor();
    monitor.recordEvent({
      runId: "run-1",
      kind: "tool",
      extensionId: "browser",
      toolName: "browser_navigate",
      handlerRef: "plugin:browser:browser_navigate",
      durationMs: 300,
    });
    monitor.recordEvent({
      runId: "run-1",
      kind: "llm",
      extensionId: "openai",
      provider: "openai",
      model: "gpt-5.5",
      providerPluginId: "openai",
      handlerRef: "provider-plugin:openai/responses",
      durationMs: 1200,
    });

    const trace = monitor.getRunTrace("run-1");
    expect(trace?.summary.totalToolMs).toBe(300);
    expect(trace?.summary.totalLlmMs).toBe(1200);
    expect(trace?.events[0]?.handlerRef).toBe("plugin:browser:browser_navigate");
    expect(trace?.events[1]?.handlerRef).toBe("provider-plugin:openai/responses");
  });

  it("trims old runs when maxRuns is exceeded", () => {
    const monitor = createPerformanceMonitor({ maxRuns: 2, maxEventsPerRun: 20 });
    monitor.recordEvent({ runId: "run-a", kind: "run" });
    monitor.recordEvent({ runId: "run-b", kind: "run" });
    monitor.recordEvent({ runId: "run-c", kind: "run" });

    const report = monitor.getReport();
    expect(report.runCount).toBe(2);
    expect(monitor.getRunTrace("run-a")).toBeUndefined();
  });
});

describe("performance-monitor service", () => {
  it("records hook handler, tool, and llm diagnostic events", () => {
    const { monitor } = createPerformanceMonitorService();
    serviceTestApi.recordDiagnosticEvent(monitor, {
      type: "hook.handler.completed",
      seq: 1,
      ts: 1_700_000_000_000,
      hookName: "before_prompt_build",
      pluginId: "memory-core",
      durationMs: 42,
      outcome: "completed",
      runId: "run-1",
    });
    serviceTestApi.recordDiagnosticEvent(monitor, {
      type: "tool.execution.completed",
      seq: 2,
      ts: 1_700_000_000_100,
      runId: "run-1",
      toolName: "web_search",
      toolOwner: "brave",
      toolSource: "plugin",
      handlerName: "web_search",
      handlerRef: "plugin:brave:web_search",
      durationMs: 250,
    });
    serviceTestApi.recordDiagnosticEvent(monitor, {
      type: "model.call.completed",
      seq: 3,
      ts: 1_700_000_001_000,
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.5",
      providerPluginId: "openai",
      handlerRef: "provider-plugin:openai/responses",
      api: "responses",
      durationMs: 1500,
    });
    serviceTestApi.recordDiagnosticEvent(monitor, {
      type: "run.completed",
      seq: 4,
      ts: 1_700_000_002_000,
      runId: "run-1",
      durationMs: 1800,
      outcome: "completed",
    });

    const trace = monitor.getRunTrace("run-1");
    expect(trace?.summary.hookHandlerCount).toBe(1);
    expect(trace?.summary.toolCallCount).toBe(1);
    expect(trace?.summary.llmCallCount).toBe(1);
    expect(trace?.events.find((event) => event.kind === "tool")).toMatchObject({
      extensionId: "brave",
      toolName: "web_search",
      handlerRef: "plugin:brave:web_search",
    });
    expect(trace?.events.find((event) => event.kind === "llm")).toMatchObject({
      extensionId: "openai",
      handlerRef: "provider-plugin:openai/responses",
      providerPluginId: "openai",
    });
    expect(trace?.breakdown.categoryTotals.llmMs).toBe(1500);
    expect(trace?.breakdown.hookHandlers[0]).toMatchObject({
      key: "hook:memory-core:before_prompt_build",
      totalMs: 42,
    });
    expect(trace?.totalDurationMs).toBe(1800);
  });

  it("ignores untrusted diagnostic events", () => {
    expect(serviceTestApi.shouldRecordDiagnosticEvent({ trusted: false })).toBe(false);
    expect(serviceTestApi.shouldRecordDiagnosticEvent(trusted)).toBe(true);
  });

  it("defaults logTimingEvents to true and allows disabling it", () => {
    expect(serviceTestApi.parsePluginConfig(undefined).logTimingEvents).toBe(true);
    expect(serviceTestApi.parsePluginConfig({ logTimingEvents: false }).logTimingEvents).toBe(
      false,
    );
  });

  it("writes perf timing logs when logTimingEvents is enabled", () => {
    const timingLogger = { info: vi.fn() };
    const { monitor } = createPerformanceMonitorService({ logTimingEvents: true });
    serviceTestApi.recordDiagnosticEvent(
      monitor,
      {
        type: "tool.execution.completed",
        seq: 1,
        ts: 1,
        runId: "run-abc",
        toolName: "read",
        toolSource: "core",
        handlerRef: "core:read",
        durationMs: 88,
        trace: { traceId: "f".repeat(32) },
      },
      { timingLogger, logTimingEvents: true },
    );
    expect(timingLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("perf timing:"),
      expect.objectContaining({
        perfTiming: true,
        runId: "run-abc",
        traceId: "f".repeat(32),
      }),
    );
  });
});

describe("performance-monitor helpers", () => {
  it("rounds millisecond metrics", () => {
    expect(monitorTestApi.roundMs(12.345)).toBe(12.3);
  });
});
