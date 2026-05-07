import fs from "node:fs/promises";
import path from "node:path";
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
  "記住：",
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

export class KnowledgeCapture {
  constructor(
    private readonly opts: {
      workspaceDir: string;
      store: LogMemoryStore;
      embed: EmbedFn;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // Returns the new entry only if a teaching moment was detected. Stores
  // semantic-layer knowledge with a high decay score so it survives several
  // dream cycles without being pruned.
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
    const id = computeEntryId({
      timestamp: now,
      service: "engineer",
      message: input.message,
    });
    const [embedding] = await this.opts.embed([input.message]);
    const entry: LogMemoryEntry = {
      id,
      timestamp: now,
      layer: "semantic",
      embedding,
      payload: {
        type: "engineer_knowledge",
        content: input.message,
        tags,
        source: "engineer_teach",
        decayScore: 0.95,
        accessCount: 0,
        lastAccessedAt: now,
      },
    };
    this.opts.store.upsert(entry);
    const knowledgeFilePath = await this.appendToKnowledgeMarkdown({
      now,
      message: input.message,
      tags: entry.payload.tags,
      title: input.title,
    });
    return { entry, knowledgeFilePath };
  }

  private async appendToKnowledgeMarkdown(input: {
    now: Date;
    message: string;
    tags: string[];
    title?: string;
  }): Promise<string> {
    const filePath = path.join(this.opts.workspaceDir, "KNOWLEDGE.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const date = input.now.toISOString().slice(0, 10);
    const heading = input.title ? `## [${date}] ${input.title}` : `## [${date}]`;
    const body = input.message.trim();
    const tagsLine = `Tags: ${input.tags.join(", ")}`;
    const block = `\n${heading}\n\n${body}\n\n${tagsLine}\n`;
    await fs.appendFile(filePath, block, "utf8");
    return filePath;
  }
}
