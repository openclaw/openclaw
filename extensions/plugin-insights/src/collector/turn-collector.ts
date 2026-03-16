import type Database from "better-sqlite3";
import type { AgentMessage, ToolCallContent, Usage } from "../types.js";
import { extractUserText, extractAssistantText, extractToolCalls, extractUsage } from "../types.js";
import { ContextDetector } from "./context-detector.js";
import { PluginReporter } from "./plugin-reporter.js";
import { ToolDetector } from "./tool-detector.js";

export class TurnCollector {
  private db: Database.Database;
  private toolDetector: ToolDetector;
  private contextDetector: ContextDetector;
  private pluginReporter: PluginReporter;

  constructor(
    db: Database.Database,
    toolDetector: ToolDetector,
    contextDetector: ContextDetector,
    pluginReporter: PluginReporter,
  ) {
    this.db = db;
    this.toolDetector = toolDetector;
    this.contextDetector = contextDetector;
    this.pluginReporter = pluginReporter;
  }

  /** Process a completed turn and store all data */
  collect(sessionId: string, turnIndex: number, messages: AgentMessage[]): number {
    const userPrompt = this.extractLastUserMessage(messages);
    const assistantResponse = this.extractLastAssistantMessage(messages);

    // Extract tool calls from assistant messages
    const toolCalls = this.extractAllToolCalls(messages);

    // Extract usage from the last assistant message
    const usage = this.extractLastUsage(messages);

    // Layer 1: Tool call attribution
    const toolDetections = this.toolDetector.detect(toolCalls);

    // Layer 2: Context injection detection
    const contextDetections = this.contextDetector.detect(messages);

    // Merge all detected plugin IDs (Layer 1 + Layer 2 + Layer 3 peek)
    const allPluginIds = new Set<string>();
    for (const d of toolDetections) allPluginIds.add(d.pluginId);
    for (const d of contextDetections) allPluginIds.add(d.pluginId);
    // Include Layer 3 self-report plugin IDs so plugins_triggered_json is complete
    for (const id of this.pluginReporter.peekMatchingPluginIds(sessionId)) allPluginIds.add(id);

    // Insert turn record
    const turnId = this.insertTurn(
      sessionId,
      turnIndex,
      userPrompt,
      assistantResponse,
      usage,
      toolCalls,
      allPluginIds,
    );

    // Insert plugin events from Layer 1
    this.insertPluginEvents(
      turnId,
      toolDetections.map((d) => ({
        pluginId: d.pluginId,
        method: "tool_call" as const,
        action: d.action,
      })),
    );

    // Insert plugin events from Layer 2
    this.insertPluginEvents(
      turnId,
      contextDetections.map((d) => ({
        pluginId: d.pluginId,
        method: "context_injection" as const,
        action: d.action,
        metadata: { marker: d.marker },
      })),
    );

    // Flush Layer 3 self-reports (session-scoped)
    this.pluginReporter.flushToTurn(turnId, sessionId);

    // Detect satisfaction signals (compare with previous turn)
    this.detectSatisfactionSignals(turnId, sessionId, userPrompt);

    return turnId;
  }

  private insertTurn(
    sessionId: string,
    turnIndex: number,
    userPrompt: string | null,
    assistantResponse: string | null,
    usage: Usage | null,
    toolCalls: ToolCallContent[],
    pluginIds: Set<string>,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO turns (
        session_id, turn_index, timestamp,
        user_prompt_preview, assistant_response_preview,
        prompt_tokens, completion_tokens, total_tokens,
        tool_calls_json, plugins_triggered_json
      ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      sessionId,
      turnIndex,
      userPrompt ? userPrompt.slice(0, 200) : null,
      assistantResponse ? assistantResponse.slice(0, 200) : null,
      usage?.input ?? null,
      usage?.output ?? null,
      usage?.total ?? null,
      toolCalls.length > 0 ? JSON.stringify(toolCalls.map((tc) => tc.name)) : null,
      pluginIds.size > 0 ? JSON.stringify([...pluginIds]) : null,
    );

    return result.lastInsertRowid as number;
  }

  private insertPluginEvents(
    turnId: number,
    events: {
      pluginId: string;
      method: "tool_call" | "context_injection";
      action: string;
      metadata?: Record<string, unknown>;
    }[],
  ): void {
    if (events.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO plugin_events (turn_id, plugin_id, detection_method, action, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const event of events) {
        stmt.run(
          turnId,
          event.pluginId,
          event.method,
          event.action,
          event.metadata ? JSON.stringify(event.metadata) : null,
        );
      }
    });
    tx();
  }

  private detectSatisfactionSignals(
    currentTurnId: number,
    sessionId: string,
    currentPrompt: string | null,
  ): void {
    if (!currentPrompt) return;

    const prevTurn = this.db
      .prepare(
        `SELECT id, user_prompt_preview FROM turns
         WHERE session_id = ? AND id < ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sessionId, currentTurnId) as
      | { id: number; user_prompt_preview: string | null }
      | undefined;

    if (!prevTurn || !prevTurn.user_prompt_preview) return;

    const prevPrompt = prevTurn.user_prompt_preview;
    const similarity = jaccardSimilarity(currentPrompt, prevPrompt);

    const stmt = this.db.prepare(`
      INSERT INTO satisfaction_signals (turn_id, signal_type, confidence, next_turn_id)
      VALUES (?, ?, ?, ?)
    `);

    if (isCorrectionSignal(currentPrompt)) {
      stmt.run(prevTurn.id, "corrected", 0.8, currentTurnId);
      return;
    }

    if (similarity > 0.6) {
      stmt.run(prevTurn.id, "retried", Math.min(similarity, 1.0), currentTurnId);
      return;
    }

    if (similarity < 0.3) {
      stmt.run(prevTurn.id, "accepted", 1.0 - similarity, currentTurnId);
    }
  }

  private extractLastUserMessage(messages: AgentMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractUserText(messages[i]);
      if (text !== null) return text;
    }
    return null;
  }

  private extractLastAssistantMessage(messages: AgentMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractAssistantText(messages[i]);
      if (text !== null) return text;
    }
    return null;
  }

  private extractAllToolCalls(messages: AgentMessage[]): ToolCallContent[] {
    const all: ToolCallContent[] = [];
    for (const msg of messages) {
      all.push(...extractToolCalls(msg));
    }
    return all;
  }

  private extractLastUsage(messages: AgentMessage[]): Usage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = extractUsage(messages[i]);
      if (usage) return usage;
    }
    return null;
  }
}

// ---- Utility Functions ----

/** Simple Jaccard similarity between two strings (word-level) */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

const CORRECTION_PATTERNS = [
  /不对/,
  /重新/,
  /换个方式/,
  /错了/,
  /不是这样/,
  /再试/,
  /wrong/i,
  /retry/i,
  /redo/i,
  /try again/i,
  /not what i/i,
  /that's not/i,
  /incorrect/i,
];

function isCorrectionSignal(prompt: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(prompt));
}
