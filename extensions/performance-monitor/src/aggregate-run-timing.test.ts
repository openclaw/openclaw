import { describe, expect, it } from "vitest";
import {
  correlateStabilityRow,
  extractEventsFromLogRecord,
  formatBreakdownTsv,
  formatEventsTsv,
  formatRunSummaryTsv,
  mergeRunWindows,
  parseOpenClawLogLine,
  stabilityRecordToTimingRow,
  testApi,
} from "../scripts/lib/aggregate-run-timing.mjs";

describe("aggregate-run-timing", () => {
  it("parses embedded run lifecycle lines and assigns runId", () => {
    const start = parseOpenClawLogLine(
      JSON.stringify({
        time: "2026-07-10T01:00:00.000Z",
        level: "info",
        subsystem: "agent/embedded",
        message:
          "embedded run start: runId=run-abc sessionId=sess-1 provider=openai model=gpt-5.5 thinking=off messageChannel=telegram",
      }),
    );
    const end = parseOpenClawLogLine(
      JSON.stringify({
        time: "2026-07-10T01:00:05.000Z",
        level: "debug",
        subsystem: "agent/embedded",
        message: "embedded run agent end: runId=run-abc isError=false",
      }),
    );

    const startEvents = extractEventsFromLogRecord(start);
    const endEvents = extractEventsFromLogRecord(end);
    const runs = mergeRunWindows([
      ...startEvents.filter((event) => event.kind === "run_window"),
      ...endEvents.filter((event) => event.kind === "run_window"),
    ]);

    expect(runs.get("run-abc")).toMatchObject({
      runId: "run-abc",
      sessionId: "sess-1",
      provider: "openai",
      model: "gpt-5.5",
      startedAt: Date.parse("2026-07-10T01:00:00.000Z"),
      endedAt: Date.parse("2026-07-10T01:00:05.000Z"),
      outcome: "completed",
    });
  });

  it("parses trace stage summaries into phase events", () => {
    const record = parseOpenClawLogLine(
      JSON.stringify({
        time: "2026-07-10T01:00:01.000Z",
        level: "warn",
        message:
          "[trace:embedded-run] startup stages: runId=run-abc sessionId=sess-1 phase=attempt-dispatch totalMs=1200 stages=attempt-workspace:400ms@400ms,attempt-prompt:800ms@1200ms",
      }),
    );
    const events = extractEventsFromLogRecord(record).filter((event) => event.kind === "phase");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({
      runId: "run-abc",
      sessionId: "sess-1",
      kind: "phase",
      durationMs: 1200,
      phaseName: "startup stages:attempt-dispatch",
      source: "log",
    });
  });

  it("maps stability hook/tool/model records and correlates by time window", () => {
    const runs = mergeRunWindows([
      {
        kind: "run_window",
        runId: "run-abc",
        startedAt: 1_000,
        endedAt: 9_000,
        sessionKey: "agent:main:demo",
        sessionId: "sess-1",
      },
    ]);

    const hookRow = stabilityRecordToTimingRow({
      seq: 10,
      ts: 2_000,
      type: "hook.handler.completed",
      pluginId: "session-memory",
      phase: "before_agent_start",
      handler: "hook:session-memory:before_agent_start@onBeforeAgentStart",
      source: "index.ts",
      durationMs: 12.4,
      outcome: "completed",
    });
    const toolRow = stabilityRecordToTimingRow({
      seq: 11,
      ts: 3_000,
      type: "tool.execution.completed",
      toolName: "read",
      source: "core",
      handler: "core:read",
      durationMs: 88,
    });
    const modelRow = stabilityRecordToTimingRow({
      seq: 12,
      ts: 4_000,
      type: "model.call.completed",
      provider: "openai",
      model: "gpt-5.5",
      pluginId: "openai",
      handler: "provider-plugin:openai/responses",
      durationMs: 1904,
    });

    expect(correlateStabilityRow(hookRow, runs)).toMatchObject({
      runId: "run-abc",
      kind: "hook_handler",
      extensionId: "session-memory",
      hookName: "before_agent_start",
      handlerName: "onBeforeAgentStart",
      handlerRef: "hook:session-memory:before_agent_start@onBeforeAgentStart",
      durationMs: 12.4,
      correlation: "time-window",
    });
    expect(correlateStabilityRow(toolRow, runs)).toMatchObject({
      runId: "run-abc",
      kind: "tool",
      toolName: "read",
      handlerRef: "core:read",
      durationMs: 88,
    });
    expect(correlateStabilityRow(modelRow, runs)).toMatchObject({
      runId: "run-abc",
      kind: "llm",
      provider: "openai",
      model: "gpt-5.5",
      providerPluginId: "openai",
      handlerRef: "provider-plugin:openai/responses",
      durationMs: 1904,
    });
  });

  it("formats one TSV row per run with aggregated event tokens", () => {
    const tsv = formatRunSummaryTsv({
      runs: [
        {
          runId: "run-abc",
          startedAt: 1_000,
          endedAt: 9_000,
          sessionKey: "agent:main:demo",
          sessionId: "sess-1",
        },
      ],
      events: [
        {
          runId: "run-abc",
          sessionKey: "agent:main:demo",
          sessionId: "sess-1",
          kind: "hook_handler",
          at: 2_000,
          durationMs: 12,
          extensionId: "session-memory",
          hookName: "before_agent_start",
          handlerRef: "hook:session-memory:before_agent_start",
          source: "stability",
          correlation: "time-window",
        },
        {
          runId: "run-abc",
          sessionKey: "agent:main:demo",
          sessionId: "sess-1",
          kind: "tool",
          at: 3_000,
          durationMs: 88,
          extensionId: "core",
          toolName: "read",
          handlerRef: "core:read",
          source: "stability",
          correlation: "time-window",
        },
      ],
    });

    const lines = tsv.trim().split("\n");
    expect(lines[0]).toContain("runId\tsessionKey");
    expect(lines[1]).toContain("run-abc");
    expect(lines[1]).toContain("hook_handler:hook:session-memory:before_agent_start=12ms");
    expect(lines[1]).toContain("tool:core → read=88ms");
  });

  it("parses perf timing lines from the shared OpenClaw file log", () => {
    const record = parseOpenClawLogLine(
      JSON.stringify({
        time: "2026-07-12T01:00:01.000Z",
        level: "info",
        subsystem: "plugins/performance-monitor",
        message:
          "perf timing: kind=hook_handler pluginId=active-memory hookName=before_prompt_build handlerRef=hook:active-memory:before_prompt_build@buildPrompt durationMs=42 outcome=completed runId=run-abc traceId=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sessionKey=agent:main:demo",
        runId: "run-abc",
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    const events = extractEventsFromLogRecord(record);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      runId: "run-abc",
      kind: "hook_handler",
      extensionId: "active-memory",
      hookName: "before_prompt_build",
      handlerRef: "hook:active-memory:before_prompt_build@buildPrompt",
      durationMs: 42,
      source: "log",
      correlation: "traceId",
    });
  });

  it("formats breakdown-tsv with hook/tool/llm rows per run", () => {
    const aggregated = {
      runs: [
        {
          runId: "run-abc",
          sessionKey: "agent:main:demo",
          sessionId: "sess-1",
          startedAt: 1,
          endedAt: 9,
        },
      ],
      events: [
        {
          runId: "run-abc",
          kind: "hook_handler",
          extensionId: "session-memory",
          hookName: "before_prompt_build",
          handlerName: "buildPrompt",
          handlerRef: "hook:session-memory:before_prompt_build@buildPrompt",
          durationMs: 28,
          source: "performance-monitor",
        },
        {
          runId: "run-abc",
          kind: "tool",
          extensionId: "core",
          toolName: "read",
          handlerRef: "core:read",
          durationMs: 88,
          source: "performance-monitor",
        },
        {
          runId: "run-abc",
          kind: "llm",
          provider: "openai",
          model: "gpt-5.5",
          handlerRef: "provider-plugin:openai/responses",
          durationMs: 1904,
          source: "performance-monitor",
        },
      ],
    };
    const breakdown = formatBreakdownTsv(aggregated).trim().split("\n");
    expect(breakdown[0]).toContain("category\tpluginId\thookName\thandlerName");
    expect(
      breakdown.some((line) =>
        line.includes("hook\tsession-memory\tbefore_prompt_build\tbuildPrompt"),
      ),
    ).toBe(true);
    expect(
      breakdown.some(
        (line) => line.includes("\ttool\tcore\t") && line.includes("\tread\tcore:read\t"),
      ),
    ).toBe(true);
    expect(
      breakdown.some(
        (line) => line.includes("\tllm\t") && line.includes("provider-plugin:openai/responses"),
      ),
    ).toBe(true);

    const events = formatEventsTsv(aggregated).trim().split("\n");
    expect(events[1]).toContain("hook:session-memory:before_prompt_build@buildPrompt");
    expect(events[1]).toContain("28");
  });
});
