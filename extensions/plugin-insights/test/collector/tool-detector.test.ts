import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ToolDetector } from "../../src/collector/tool-detector.js";
import { runMigrations } from "../../src/db/migration.js";
import type { ToolCallContent } from "../../src/types.js";

describe("ToolDetector", () => {
  let db: Database.Database;
  let detector: ToolDetector;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    detector = new ToolDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should detect tool calls from registered plugins", () => {
    const entries = [
      { toolName: "memory_search", pluginId: "memory-core", pluginName: "Memory Core" },
      { toolName: "memory_store", pluginId: "memory-core", pluginName: "Memory Core" },
      { toolName: "format_code", pluginId: "code-fmt", pluginName: "Code Formatter" },
    ];

    detector.refreshMappingFromEntries(entries);

    const toolCalls: ToolCallContent[] = [
      { type: "toolCall", id: "tc1", name: "memory_search", arguments: {} },
      { type: "toolCall", id: "tc2", name: "unknown_tool", arguments: {} },
    ];

    const results = detector.detect(toolCalls);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ pluginId: "memory-core", action: "memory_search" });
  });

  it("should not duplicate detections for the same plugin+tool", () => {
    detector.refreshMappingFromEntries([
      { toolName: "mem_recall", pluginId: "mem", pluginName: "Mem" },
    ]);

    const toolCalls: ToolCallContent[] = [
      { type: "toolCall", id: "tc1", name: "mem_recall", arguments: {} },
      { type: "toolCall", id: "tc2", name: "mem_recall", arguments: {} },
    ];

    const results = detector.detect(toolCalls);
    expect(results).toHaveLength(1);
  });

  it("should return empty for unrecognized tools", () => {
    const toolCalls: ToolCallContent[] = [
      { type: "toolCall", id: "tc1", name: "unknown_tool", arguments: {} },
    ];

    const results = detector.detect(toolCalls);
    expect(results).toHaveLength(0);
  });

  it("should handle entries without pluginName", () => {
    detector.refreshMappingFromEntries([{ toolName: "some_tool", pluginId: "no-name" }]);

    expect(detector.getPluginForTool("some_tool")).toBe("no-name");
    expect(detector.getPluginForTool("anything")).toBeUndefined();
  });
});
