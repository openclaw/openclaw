/**
 * Observer — Heuristic + optional LLM compression of conversation messages into observations.
 *
 * Compresses tool-call-heavy workloads by 5-40x while preserving critical information.
 * Integrates the three-date temporal model for all observations.
 */

import { randomUUID } from "node:crypto";
import {
  type Observation,
  type ObservationLog,
  type ObservationPriority,
  priorityEmoji,
} from "./observation-types.js";
import { extractReferencedDates } from "./temporal-utils.js";

// ── Configuration ──

export interface ObserverConfig {
  tokenThreshold: number;
  maxObservationsBeforeReflect: number;
  enabled: boolean;
  mode: "heuristic" | "llm" | "hybrid";
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  tokenThreshold: 30000,
  maxObservationsBeforeReflect: 100,
  enabled: true,
  mode: "hybrid",
};

// ── Token Estimation ──

/** Matches existing convention in context-pruning/pruner.ts: chars / 4 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Message Types (minimal interface for what we consume) ──

export interface ObservableMessage {
  role: "user" | "assistant" | "tool";
  content?: string;
  tool_call_id?: string;
  name?: string;
  timestamp?: string;
}

// ── Heuristic Compression ──

function classifyPriority(content: string): ObservationPriority {
  const lower = content.toLowerCase();
  // Errors and failures are critical
  if (/error|fail|crash|exception|bug|broken|critical/i.test(lower)) return "critical";
  // Decisions, plans, and important outcomes
  if (/decid|decision|plan:|chose|will\s|resolv|fix|implement/i.test(lower)) return "important";
  return "routine";
}

function extractTags(content: string): string[] {
  const tags = new Set<string>();
  // Extract file paths
  const pathPattern = /(?:[\w-]+\/)+[\w.-]+\.\w+/g;
  let m: RegExpExecArray | null;
  while ((m = pathPattern.exec(content)) !== null) {
    tags.add(`file:${m[0]}`);
  }
  // Extract tool names
  const toolPattern = /\btool[_\s]?(?:call|use|name)?[:\s]+["']?(\w+)/gi;
  while ((m = toolPattern.exec(content)) !== null) {
    tags.add(`tool:${m[1]}`);
  }
  return Array.from(tags).slice(0, 10);
}

function compressToolResult(content: string): string {
  if (content.length < 200) return content;

  // Error extraction
  if (/error|Error|ERROR|fail|Fail|FAIL/.test(content)) {
    // Extract the core error message, drop stack traces
    const lines = content.split("\n");
    const errorLines = lines.filter(
      (l) => /error|Error|fail|Fail|caused by/i.test(l) && !/^\s+at\s/.test(l),
    );
    if (errorLines.length > 0) {
      return errorLines.slice(0, 5).join("\n");
    }
  }

  // File/search results — extract filenames and key lines
  if (/\.(ts|js|py|md|json|yaml|yml|toml)[\s:]/i.test(content)) {
    const lines = content.split("\n");
    const keyLines = lines.filter(
      (l) =>
        /\.(ts|js|py|md|json)/.test(l) ||
        /^(import|export|class|function|const|def |async )/.test(l.trim()),
    );
    if (keyLines.length > 0) {
      return keyLines.slice(0, 10).join("\n");
    }
  }

  // Generic: first 150 + last 150
  return content.slice(0, 150) + "\n...compressed...\n" + content.slice(-150);
}

function compressAssistantMessage(content: string): string {
  if (content.length < 300) return content;

  const lines = content.split("\n");
  const keyLines = lines.filter(
    (l) =>
      /I will|decided|plan:|going to|chose|conclusion|summary|result/i.test(l) ||
      /^[-*]\s/.test(l.trim()) || // Bullet points
      /^#{1,3}\s/.test(l.trim()), // Headers
  );

  if (keyLines.length > 0) {
    return keyLines.slice(0, 15).join("\n");
  }

  // Fallback: first 200 chars
  return content.slice(0, 200) + "...";
}

function compressUserMessage(content: string): string {
  if (content.length < 300) return content;

  // Extract the key sentence/request
  const sentences = content.split(/[.!?]\s+/);
  const keySentences = sentences.filter((s) =>
    /please|want|need|should|could|fix|add|create|update|delete|help|how/i.test(s),
  );

  if (keySentences.length > 0) {
    return keySentences.slice(0, 3).join(". ") + ".";
  }

  return content.slice(0, 200) + "...";
}

// ── Core Observer ──

export function compressMessagesToObservations(
  messages: ObservableMessage[],
  existingObs: Observation[],
  _config?: Partial<ObserverConfig>,
): {
  observations: Observation[];
  messagesCompressed: number;
  toolCallsCompressed: number;
} {
  const observations: Observation[] = [];
  let messagesCompressed = 0;
  let toolCallsCompressed = 0;
  const now = new Date().toISOString();
  const existingIds = new Set(existingObs.map((o) => o.id));

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const content = msg.content ?? "";
    if (!content.trim()) continue;

    let compressed: string;
    let priority: ObservationPriority;

    if (msg.role === "tool") {
      compressed = compressToolResult(content);
      priority = classifyPriority(content);
      toolCallsCompressed++;
    } else if (msg.role === "assistant") {
      compressed = compressAssistantMessage(content);
      priority = classifyPriority(content);
    } else {
      // user
      compressed = compressUserMessage(content);
      priority = "important"; // User messages are at least important
    }

    const timestamp = msg.timestamp ?? now;
    const referencedDates = extractReferencedDates(compressed, new Date(timestamp));

    const id = `obs-${randomUUID()}`;
    if (existingIds.has(id)) continue; // Skip duplicates (astronomically unlikely)

    observations.push({
      id,
      priority,
      content: compressed,
      observed_at: timestamp,
      referenced_dates: referencedDates.length > 0 ? referencedDates : undefined,
      source_message_range: [i, i],
      source_tool_calls: msg.name ? [msg.name] : undefined,
      tags: extractTags(compressed),
      created_at: now,
    });

    messagesCompressed++;
  }

  return { observations, messagesCompressed, toolCallsCompressed };
}

// ── Observation Log Formatting (deterministic for cache stability) ──

export function formatObservationLog(observations: Observation[]): string {
  if (observations.length === 0) return "";

  // Group by date, sorted chronologically
  const byDate = new Map<string, Observation[]>();
  for (const obs of observations) {
    const date = obs.observed_at.split("T")[0] || "unknown";
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(obs);
  }

  const sortedDates = Array.from(byDate.keys()).sort();
  const lines: string[] = ["## Observation Log", ""];

  for (const date of sortedDates) {
    lines.push(`### ${date}`);
    const dayObs = byDate.get(date)!;

    // Sort within day: critical first, then important, then routine
    const priorityOrder: Record<ObservationPriority, number> = {
      critical: 0,
      important: 1,
      routine: 2,
    };
    dayObs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    for (const obs of dayObs) {
      if (obs.superseded_by) continue; // Skip superseded
      const emoji = priorityEmoji(obs.priority);
      // Single line per observation for compactness
      const contentLine = obs.content.split("\n")[0].slice(0, 200);
      lines.push(`${emoji} ${contentLine}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
