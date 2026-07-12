// Live-style demo: replay realistic diagnostics and print per-plugin breakdown.
import { describe, expect, it } from "vitest";
import { createPerformanceMonitorService, testApi } from "./service.js";

const userMessage = "请读取 workspace 里的 README.md，用一句话总结，并列出当前目录前 3 个文件名。";

function printDemoReport(
  runId: string,
  monitor: ReturnType<typeof createPerformanceMonitorService>["monitor"],
) {
  const trace = monitor.getRunTrace(runId);
  expect(trace).toBeDefined();
  const run = trace!;

  const lines: string[] = [];
  lines.push(`\n=== 模拟用户输入 ===`);
  lines.push(`message: ${userMessage}`);
  lines.push(`runId: ${run.runId}`);
  lines.push(`totalDurationMs: ${run.totalDurationMs ?? "n/a"}`);
  lines.push(
    `summary: hooks=${run.summary.totalHookHandlerMs}ms (${run.summary.hookHandlerCount}), tools=${run.summary.totalToolMs}ms (${run.summary.toolCallCount}), llm=${run.summary.totalLlmMs}ms (${run.summary.llmCallCount}), phases=${run.summary.totalPhaseMs}ms (${run.summary.phaseCount})`,
  );
  lines.push(`categoryTotals: ${JSON.stringify(run.breakdown.categoryTotals)}`);

  for (const [key, label] of [
    ["phases", "环节"],
    ["hookHandlers", "插件 Hook"],
    ["tools", "工具调用"],
    ["llmCalls", "模型调用"],
    ["byExtension", "按插件汇总"],
  ] as const) {
    const rows = run.breakdown[key];
    if (rows.length === 0) {
      continue;
    }
    lines.push(`\n-- ${label} --`);
    for (const row of rows) {
      lines.push(
        `  ${row.label}: total=${row.totalMs}ms count=${row.count} avg=${row.avgMs}ms max=${row.maxMs}ms`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

describe("performance-monitor demo simulate", () => {
  it("prints multi-plugin timing for one user turn", () => {
    const { monitor } = createPerformanceMonitorService();
    const runId = "demo-run-001";
    const ts = 1_700_000_000_000;
    const emit = (event: Parameters<typeof testApi.recordDiagnosticEvent>[1]) =>
      testApi.recordDiagnosticEvent(monitor, event);

    emit({ type: "run.started", seq: 1, ts, runId, sessionKey: "agent:main:perf-demo" });
    emit({
      type: "diagnostic.phase.completed",
      seq: 2,
      ts: ts + 10,
      runId,
      name: "session_prepare",
      startedAt: ts + 5,
      endedAt: ts + 45,
      durationMs: 40,
    });
    emit({
      type: "hook.handler.completed",
      seq: 3,
      ts: ts + 50,
      runId,
      pluginId: "session-memory",
      hookName: "before_prompt_build",
      durationMs: 28,
      outcome: "completed",
    });
    emit({
      type: "hook.handler.completed",
      seq: 4,
      ts: ts + 80,
      runId,
      pluginId: "boot-md",
      hookName: "before_agent_start",
      durationMs: 12,
      outcome: "completed",
    });
    emit({
      type: "diagnostic.phase.completed",
      seq: 5,
      ts: ts + 100,
      runId,
      name: "prompt_build",
      startedAt: ts + 60,
      endedAt: ts + 180,
      durationMs: 120,
    });
    emit({
      type: "model.call.completed",
      seq: 6,
      ts: ts + 200,
      runId,
      callId: `${runId}:model:1`,
      provider: "custom-models-proxy-stepfun-inc-com",
      model: "deepseek-v4-pro-aliyun",
      providerPluginId: "openai",
      api: "openai-completions",
      handlerRef: "provider-plugin:openai/openai-completions",
      durationMs: 1800,
    });
    emit({
      type: "tool.execution.completed",
      seq: 7,
      ts: ts + 2100,
      runId,
      toolName: "read",
      toolSource: "core",
      handlerName: "read",
      handlerRef: "core:read",
      durationMs: 35,
      toolCallId: "tool-1",
    });
    emit({
      type: "hook.handler.completed",
      seq: 8,
      ts: ts + 2140,
      runId,
      pluginId: "feishu",
      hookName: "after_tool_call",
      durationMs: 8,
      outcome: "completed",
    });
    emit({
      type: "tool.execution.completed",
      seq: 9,
      ts: ts + 2200,
      runId,
      toolName: "list",
      toolSource: "core",
      handlerName: "list",
      handlerRef: "core:list",
      durationMs: 22,
      toolCallId: "tool-2",
    });
    emit({
      type: "model.call.completed",
      seq: 10,
      ts: ts + 2300,
      runId,
      callId: `${runId}:model:2`,
      provider: "custom-models-proxy-stepfun-inc-com",
      model: "deepseek-v4-pro-aliyun",
      providerPluginId: "openai",
      api: "openai-completions",
      handlerRef: "provider-plugin:openai/openai-completions",
      durationMs: 950,
    });
    emit({
      type: "hook.handler.completed",
      seq: 11,
      ts: ts + 3260,
      runId,
      pluginId: "command-logger",
      hookName: "before_agent_reply",
      durationMs: 5,
      outcome: "completed",
    });
    emit({
      type: "run.completed",
      seq: 12,
      ts: ts + 3300,
      runId,
      durationMs: 3300,
      outcome: "completed",
    });

    printDemoReport(runId, monitor);
  });
});
