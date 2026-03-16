import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/db/migration.js";
import { createInsightsEngine, buildReport, type ToolPluginMapping } from "../src/engine.js";
import type { AgentMessage, UserMessage, AssistantMessage, PluginInsightsConfig } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function mkUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function mkAssistantMessage(
  text: string,
  opts?: {
    toolCalls?: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }[];
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  }
): AssistantMessage {
  const contentArr: AssistantMessage["content"] = [{ type: "text", text }];
  if (opts?.toolCalls) {
    contentArr.push(...opts.toolCalls);
  }
  return {
    role: "assistant",
    content: contentArr,
    usage: opts?.usage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    model: "test",
    api: "test",
    provider: "test",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Integration test: simulates the full lifecycle of
 * register → afterTurn (multiple) → buildReport
 */
describe("Integration: full lifecycle", () => {
  let db: Database.Database;
  const config: PluginInsightsConfig = { ...DEFAULT_CONFIG };

  const toolPluginMappings: ToolPluginMapping[] = [
    { toolName: "memory_search", pluginId: "memory-tools", pluginName: "Memory Tools" },
    { toolName: "memory_store", pluginId: "memory-tools", pluginName: "Memory Tools" },
    { toolName: "format_code", pluginId: "code-fmt", pluginName: "Code Formatter" },
  ];

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should collect data across multiple turns and produce a report", async () => {
    const { engine, reporter } = createInsightsEngine(db, config, toolPluginMappings);

    // Turn 1: memory_search triggered
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("What was the bug I fixed yesterday?"),
        mkAssistantMessage("Based on your memory, you fixed the auth timeout bug.", {
          toolCalls: [
            { type: "toolCall", id: "tc1", name: "memory_search", arguments: { query: "bug fix" } },
          ],
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, total: 700 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    // Turn 2: no plugin triggered
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("What was the bug I fixed yesterday?"),
        mkAssistantMessage("Based on your memory, you fixed the auth timeout bug.", {
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, total: 700 },
        }),
        mkUserMessage("Thanks, now help me write a React component."),
        mkAssistantMessage("Sure, here is a component...", {
          usage: { input: 600, output: 300, cacheRead: 0, cacheWrite: 0, total: 900 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    // Turn 3: format_code triggered
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("Format this code for me"),
        mkAssistantMessage("Here is the formatted code...", {
          toolCalls: [
            { type: "toolCall", id: "tc2", name: "format_code", arguments: {} },
          ],
          usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, total: 400 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    // Turn 4: memory_search again in new session
    await engine.afterTurn!({
      sessionId: "sess-2",
      sessionFile: "/tmp/sess-2.json",
      messages: [
        mkUserMessage("Recall my notes on database design"),
        mkAssistantMessage("Here are your notes...", {
          toolCalls: [
            { type: "toolCall", id: "tc3", name: "memory_search", arguments: {} },
          ],
          usage: { input: 400, output: 150, cacheRead: 0, cacheWrite: 0, total: 550 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    // Verify raw data
    const turns = db.prepare("SELECT * FROM turns").all();
    expect(turns).toHaveLength(4);

    const events = db.prepare("SELECT * FROM plugin_events").all() as any[];
    expect(events.length).toBeGreaterThanOrEqual(2); // at least memory-tools + code-fmt

    const memEvents = events.filter((e: any) => e.plugin_id === "memory-tools");
    expect(memEvents).toHaveLength(2);

    // Build report
    const report = buildReport(db, config, 30);
    expect(report.plugins.length).toBeGreaterThanOrEqual(1);

    const memPlugin = report.plugins.find((p) => p.pluginId === "memory-tools");
    expect(memPlugin).toBeDefined();
    expect(memPlugin!.triggerFrequency.totalTriggers).toBe(2);
  });

  it("should handle Layer 3 self-reports", async () => {
    const { engine, reporter } = createInsightsEngine(db, config, toolPluginMappings);

    // Simulate another plugin reporting its activity
    reporter.report({ pluginId: "custom-plugin", action: "custom_action", metadata: { foo: "bar" } });

    // The report gets flushed during the next afterTurn
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("Hello"),
        mkAssistantMessage("Hi there!", {
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    const events = db.prepare("SELECT * FROM plugin_events WHERE plugin_id = 'custom-plugin'").all() as any[];
    expect(events).toHaveLength(1);
    expect(events[0].detection_method).toBe("self_report");
    expect(events[0].action).toBe("custom_action");
  });

  it("should detect satisfaction signals across turns", async () => {
    const { engine } = createInsightsEngine(db, config, toolPluginMappings);

    // Turn 1: user asks a question
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("How do I optimize database queries for large tables?"),
        mkAssistantMessage("You can use indexing and query optimization...", {
          toolCalls: [
            { type: "toolCall", id: "tc1", name: "memory_search", arguments: {} },
          ],
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, total: 700 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    // Turn 2: user retries (similar prompt → dissatisfied)
    await engine.afterTurn!({
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.json",
      messages: [
        mkUserMessage("How do I optimize database queries for large tables?"),
        mkAssistantMessage("You can use indexing and query optimization...", {
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, total: 700 },
        }),
        mkUserMessage("不对，重新回答一下优化数据库查询的方法"),
        mkAssistantMessage("Let me provide a more detailed answer...", {
          usage: { input: 600, output: 300, cacheRead: 0, cacheWrite: 0, total: 900 },
        }),
      ],
      prePromptMessageCount: 0,
    });

    const signals = db.prepare("SELECT * FROM satisfaction_signals").all() as any[];
    expect(signals.length).toBeGreaterThanOrEqual(1);
    // Should detect correction signal ("不对", "重新")
    expect(signals[0].signal_type).toBe("corrected");
  });
});
