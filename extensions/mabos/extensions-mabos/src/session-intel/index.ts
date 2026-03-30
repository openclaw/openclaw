import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "../tools/common.js";
import { SessionRecall } from "./recall.js";
import { SessionIndex } from "./session-index.js";
import type { SessionIntelConfig } from "./types.js";

export function registerSessionIntel(
  api: OpenClawPluginApi,
  config: { sessionIntel?: SessionIntelConfig },
): void {
  const log = api.logger;
  const siConfig = config.sessionIntel ?? {};
  const workspaceDir = resolveWorkspaceDir(api);
  const dbDir = join(workspaceDir, "session-intel");

  try {
    mkdirSync(dbDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const dbPath = siConfig.fts?.dbPath ?? join(dbDir, "sessions.db");
  const index = new SessionIndex(dbPath);
  const recall = new SessionRecall(index);

  // Tool: session_search
  api.registerTool({
    name: "session_search",
    label: "Search Past Sessions",
    description:
      "Full-text search across all past conversation sessions. Returns matching messages with context.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      agent_id: Type.Optional(Type.String({ description: "Filter by agent" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
    }),
    async execute(_id: string, params: { query: string; agent_id?: string; limit?: number }) {
      const results = index.search(params.query, { agentId: params.agent_id, limit: params.limit });
      if (results.length === 0) return textResult(`No results found for "${params.query}".`);
      const lines = results.map(
        (r) =>
          `[${r.agentId}/${r.sessionId}] ${r.role}: ${r.content.slice(0, 200)}${r.content.length > 200 ? "..." : ""}`,
      );
      return textResult(
        `Search results for "${params.query}" (${results.length}):\n${lines.join("\n")}`,
      );
    },
  } as AnyAgentTool);

  // Tool: session_recall
  api.registerTool({
    name: "session_recall",
    label: "Recall Past Context",
    description:
      "Retrieve and summarize relevant context from past sessions, grouped by conversation.",
    parameters: Type.Object({
      query: Type.String({ description: "What to recall" }),
      agent_id: Type.Optional(Type.String({ description: "Filter by agent" })),
      limit: Type.Optional(Type.Number({ description: "Max sessions (default: 5)" })),
    }),
    async execute(_id: string, params: { query: string; agent_id?: string; limit?: number }) {
      const results = await recall.recall({
        query: params.query,
        agentId: params.agent_id,
        limit: params.limit,
      });
      if (results.length === 0) return textResult(`No past context found for "${params.query}".`);
      const sections = results.map((r) => {
        const msgs = r.messages.map((m) => `  ${m.role}: ${m.content.slice(0, 150)}`).join("\n");
        return `Session: ${r.sessionTitle ?? r.sessionId} (agent: ${r.agentId})\n${msgs}`;
      });
      return textResult(`Recalled ${results.length} sessions:\n\n${sections.join("\n\n")}`);
    },
  } as AnyAgentTool);

  // Hook: index sessions on end
  api.on("session_end", async (ctx: Record<string, unknown>) => {
    try {
      const sessionId = (ctx.sessionId as string) ?? `session-${Date.now()}`;
      index.indexSession({
        id: sessionId,
        agentId: (ctx.agentId as string) ?? "unknown",
        companyId: (ctx.companyId as string) ?? "default",
        source: (ctx.source as string) ?? null,
        startedAt: (ctx.startedAt as number) ?? Date.now(),
        endedAt: Date.now(),
        messageCount: Array.isArray(ctx.messages) ? ctx.messages.length : 0,
        title: (ctx.title as string) ?? null,
        summary: null,
      });
      const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
      for (const msg of messages) {
        const m = msg as Record<string, unknown>;
        if (!m.content) continue;
        index.indexMessage({
          sessionId,
          role: (m.role as string) ?? "unknown",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          toolName: (m.toolName as string) ?? null,
          timestamp: (m.timestamp as number) ?? Date.now(),
        });
      }
    } catch (err) {
      log.warn(`[session-intel] Failed to index session: ${err}`);
    }
  });

  log.info("[session-intel] Session intelligence initialized (FTS5 index + recall)");
}

export { SessionIndex } from "./session-index.js";
export { SessionRecall } from "./recall.js";
