import { computeEntryId } from "./dedupe.js";
import type { LogMemoryStore } from "./store.js";
import type { EmbedFn, LogMemoryEntry } from "./types.js";

const TEACH_PHRASES = [
  // Chinese — common phrasing used by factory-floor engineers when teaching.
  "這個錯誤是",
  "原因是",
  "你需要記住",
  "你需要記得",
  "記住:",
  "記住:",
  "記住",
  "下次遇到",
  "這代表",
  // English variants.
  "the issue is",
  "root cause",
  "the root cause is",
  "remember that",
  "note:",
  "fyi:",
  "this happens because",
];

const TEACH_PREFIXES = ["TEACH:", "FACT:", "RULE:"];

export function detectTeachingMoment(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  for (const prefix of TEACH_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return true;
    }
  }
  const lower = trimmed.toLowerCase();
  for (const phrase of TEACH_PHRASES) {
    const needle = phrase.toLowerCase();
    if (lower.includes(needle)) {
      return true;
    }
  }
  return false;
}

export interface KnowledgeCaptureRecord {
  entry: LogMemoryEntry;
  knowledgeFilePath: string;
}

// Captures engineer-supplied knowledge straight into the semantic layer
// (KNOWLEDGE.md). Decay starts high so the entry survives several dream
// cycles. Embedding is not stored — query() recomputes when needed.
export class KnowledgeCapture {
  constructor(
    private readonly opts: {
      // workspaceDir is accepted for parity with the previous API; the actual
      // file path comes from the store so callers don't need to know layout.
      workspaceDir: string;
      store: LogMemoryStore;
      embed: EmbedFn;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async maybeCapture(input: {
    message: string;
    tags?: string[];
    title?: string;
  }): Promise<KnowledgeCaptureRecord | null> {
    if (!detectTeachingMoment(input.message)) {
      return null;
    }
    return await this.capture(input);
  }

  async capture(input: {
    message: string;
    tags?: string[];
    title?: string;
  }): Promise<KnowledgeCaptureRecord> {
    const now = this.now();
    const tags = ["source:engineer_teach", ...(input.tags ?? [])];
    const id = computeEntryId({ timestamp: now, service: "engineer", message: input.message });
    const entry: LogMemoryEntry = {
      id,
      timestamp: now,
      layer: "semantic",
      payload: {
        type: "engineer_knowledge",
        content: input.message,
        tags,
        source: "engineer_teach",
        decayScore: 0.95,
        accessCount: 0,
        lastAccessedAt: now,
        title: input.title,
      },
    };
    await this.opts.store.appendSemantic(entry);
    return { entry, knowledgeFilePath: this.opts.store.semanticPath() };
  }
}
