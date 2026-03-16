import type Database from "better-sqlite3";
import type { ToolCallContent, ToolPluginMappingRow } from "../types.js";

/** Tools built into the OpenClaw agent runtime (not owned by any plugin) */
const BUILTIN_TOOLS = new Set([
  // Core agent tools
  "web_search",
  "web_browse",
  "web_fetch",
  "write_file",
  "read_file",
  "edit_file",
  "list_files",
  "run_command",
  "run_shell",
  "create_file",
  "delete_file",
  "search_code",
  "search_files",
  // Our own tools (should never be attributed)
  "insights_show",
  "insights_compare",
]);

/**
 * Layer 1: Tool Call Attribution
 * Matches tool calls in a turn to known plugin-registered tools.
 */
export class ToolDetector {
  private db: Database.Database;
  private mappingCache: Map<string, string> = new Map();
  /** In-memory set of tools already persisted this session — avoids repeated DB writes */
  private knownUnmapped: Set<string> = new Set();

  constructor(db: Database.Database) {
    this.db = db;
    this.loadMappingCache();
  }

  /** Rebuild the tool→plugin mapping from explicit entries */
  refreshMappingFromEntries(
    entries: { toolName: string; pluginId: string; pluginName?: string }[],
  ): void {
    const upsert = this.db.prepare(`
      INSERT INTO tool_plugin_mapping (tool_name, plugin_id, plugin_name, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(tool_name) DO UPDATE SET
        plugin_id = excluded.plugin_id,
        plugin_name = excluded.plugin_name,
        updated_at = datetime('now')
    `);

    const tx = this.db.transaction(() => {
      for (const entry of entries) {
        upsert.run(entry.toolName, entry.pluginId, entry.pluginName ?? null);
      }
    });
    tx();

    this.loadMappingCache();
  }

  /** Detect which plugins were triggered by tool calls in this turn */
  detect(toolCalls: ToolCallContent[]): { pluginId: string; action: string }[] {
    const results: { pluginId: string; action: string }[] = [];
    const seen = new Set<string>();

    for (const tc of toolCalls) {
      const toolName = tc.name;
      const pluginId = this.mappingCache.get(toolName);
      if (pluginId) {
        const key = `${pluginId}:${toolName}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ pluginId, action: toolName });
        }
      }
    }

    return results;
  }

  /** Get the plugin ID for a given tool name */
  getPluginForTool(toolName: string): string | undefined {
    return this.mappingCache.get(toolName);
  }

  /** Record a tool name observed at runtime (after_tool_call hook).
   *  Only records non-builtin, non-self tools that are NOT already
   *  mapped to a plugin. Persists to SQLite so observations survive restarts.
   *  Does NOT create fake plugin entries — unmapped tools are stored for
   *  diagnostics only and won't appear in attribution reports until the
   *  user adds a toolMapping. */
  learnTool(toolName: string): void {
    // Already mapped to a real plugin — nothing to learn
    if (this.mappingCache.has(toolName)) return;

    // Skip built-in agent tools
    if (BUILTIN_TOOLS.has(toolName)) return;

    if (this.knownUnmapped.has(toolName)) {
      // Already seen this session — just bump the count
      this.db
        .prepare(
          `UPDATE observed_unmapped_tools
         SET call_count = call_count + 1, last_seen_at = datetime('now')
         WHERE tool_name = ?`,
        )
        .run(toolName);
    } else {
      // First time this session (may or may not exist in DB from prior sessions)
      this.db
        .prepare(
          `INSERT INTO observed_unmapped_tools (tool_name, call_count)
         VALUES (?, 1)
         ON CONFLICT(tool_name) DO UPDATE SET
           call_count = call_count + 1,
           last_seen_at = datetime('now')`,
        )
        .run(toolName);
      this.knownUnmapped.add(toolName);
    }
  }

  /** Get tool names observed at runtime that have no plugin mapping.
   *  Reads from DB, excluding any tools that have since been mapped.
   *  Useful for diagnostics: tell the user which tools need a toolMapping. */
  getUnmappedTools(): string[] {
    return this.getUnmappedToolsWithCounts().map((t) => t.toolName);
  }

  /** Get unmapped tools with their observation counts, sorted by count descending.
   *  Reads from DB so observations survive across restarts.
   *  Excludes tools that have since been added to tool_plugin_mapping. */
  getUnmappedToolsWithCounts(): { toolName: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT tool_name, call_count FROM observed_unmapped_tools
       WHERE tool_name NOT IN (SELECT tool_name FROM tool_plugin_mapping)
       ORDER BY call_count DESC`,
      )
      .all() as { tool_name: string; call_count: number }[];

    return rows.map((r) => ({ toolName: r.tool_name, count: r.call_count }));
  }

  /** Build a coverage disclaimer when unmapped tools are observed alongside mapped ones.
   *  Returns null if there are no unmapped tools (report has full coverage).
   *  Centralised here so all output paths (show/compare/export/dashboard) share one source. */
  formatCoverageNote(): string | null {
    const unmapped = this.getUnmappedToolsWithCounts();
    if (unmapped.length === 0) return null;

    const totalCalls = unmapped.reduce((sum, t) => sum + t.count, 0);
    const toolList = unmapped.map((t) => t.toolName).join(", ");

    return [
      `\n⚠️  Partial coverage: ${unmapped.length} tool(s) observed but not mapped (${totalCalls} call${totalCalls === 1 ? "" : "s"} total): ${toolList}`,
      `   The results above only reflect plugins with configured toolMappings.`,
      `   Run /insights-status to see unmapped tools and configure tracking.`,
    ].join("\n");
  }

  private loadMappingCache(): void {
    this.mappingCache.clear();
    const rows = this.db
      .prepare("SELECT tool_name, plugin_id FROM tool_plugin_mapping")
      .all() as ToolPluginMappingRow[];

    for (const row of rows) {
      this.mappingCache.set(row.tool_name, row.plugin_id);
    }
  }
}
