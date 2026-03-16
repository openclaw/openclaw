import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/db/migration.js";
import { TurnCollector, jaccardSimilarity } from "../../src/collector/turn-collector.js";
import { ToolDetector } from "../../src/collector/tool-detector.js";
import { ContextDetector } from "../../src/collector/context-detector.js";
import { PluginReporter } from "../../src/collector/plugin-reporter.js";
import type { AgentMessage, UserMessage, AssistantMessage } from "../../src/types.js";

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

describe("TurnCollector", () => {
  let db: Database.Database;
  let collector: TurnCollector;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);

    const toolDetector = new ToolDetector(db);
    toolDetector.refreshMappingFromEntries([
      { toolName: "memory_search", pluginId: "mem", pluginName: "Memory" },
    ]);

    const contextDetector = new ContextDetector();
    const pluginReporter = new PluginReporter(db);

    collector = new TurnCollector(db, toolDetector, contextDetector, pluginReporter);
  });

  afterEach(() => {
    db.close();
  });

  it("should insert a turn record", () => {
    const messages: AgentMessage[] = [
      mkUserMessage("What did I do yesterday?"),
      mkAssistantMessage("Based on your history..."),
    ];

    const turnId = collector.collect("sess-1", 0, messages);
    expect(turnId).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as any;
    expect(row.session_id).toBe("sess-1");
    expect(row.turn_index).toBe(0);
    expect(row.total_tokens).toBe(150);
    expect(row.user_prompt_preview).toBe("What did I do yesterday?");
  });

  it("should detect and record tool-call plugin events", () => {
    const messages: AgentMessage[] = [
      mkUserMessage("Recall something"),
      mkAssistantMessage("Here you go", {
        toolCalls: [
          { type: "toolCall", id: "tc1", name: "memory_search", arguments: {} },
        ],
      }),
    ];

    const turnId = collector.collect("sess-1", 0, messages);

    const events = db
      .prepare("SELECT * FROM plugin_events WHERE turn_id = ?")
      .all(turnId) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].plugin_id).toBe("mem");
    expect(events[0].detection_method).toBe("tool_call");
  });

  it("should detect satisfaction signals between turns", () => {
    // First turn
    const messages1: AgentMessage[] = [
      mkUserMessage("How do I configure webpack?"),
      mkAssistantMessage("You can use webpack.config.js..."),
    ];
    collector.collect("sess-1", 0, messages1);

    // Second turn with completely different topic → accepted
    const messages2: AgentMessage[] = [
      mkUserMessage("How do I configure webpack?"),
      mkAssistantMessage("You can use webpack.config.js..."),
      mkUserMessage("Now let me work on the database schema"),
      mkAssistantMessage("Sure, here is a schema..."),
    ];
    collector.collect("sess-1", 1, messages2);

    const signals = db.prepare("SELECT * FROM satisfaction_signals").all() as any[];
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].signal_type).toBe("accepted");
  });

  it("should truncate previews to 200 chars", () => {
    const longText = "a".repeat(500);
    const messages: AgentMessage[] = [
      mkUserMessage(longText),
      mkAssistantMessage(longText),
    ];

    const turnId = collector.collect("sess-1", 0, messages);
    const row = db.prepare("SELECT * FROM turns WHERE id = ?").get(turnId) as any;
    expect(row.user_prompt_preview.length).toBe(200);
    expect(row.assistant_response_preview.length).toBe(200);
  });
});

describe("jaccardSimilarity", () => {
  it("should return 1 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("should return 0 for completely different strings", () => {
    expect(jaccardSimilarity("hello world", "foo bar baz")).toBe(0);
  });

  it("should return a value between 0 and 1 for partially similar strings", () => {
    const sim = jaccardSimilarity("configure webpack", "configure babel");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it("should handle empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(1);
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });
});
