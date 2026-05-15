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

// Implicit rule patterns — detect naming conventions, policies, and mandates
// even when the speaker uses no explicit teaching marker. Both Chinese and
// English variants are listed. Each pattern is tested case-insensitively.
const IMPLICIT_RULE_PATTERNS: RegExp[] = [
  // Chinese imperative/mandate patterns.
  /必須|一律|都要|都必須/,
  /不能|不可以|禁止|不准|絕對不/,
  /所有.{1,20}(名稱|變數|函數|函式|檔案|目錄|模組|命名)/,
  /命名(規則|規範|慣例|格式|方式)/,
  /格式(規則|規範|要求|必須)/,
  /公司(規定|規範|標準|要求)/,
  /強硬規範|強制規範|強制要求/,
  /我們的(規範|規則|標準|慣例)/,
  /開頭|結尾|前綴|後綴|prefix|suffix/,
  // English mandate patterns.
  /\b(must|always|never|shall)\b.{3,60}\b(be|use|start|end|follow|have)\b/i,
  /\ball\b.{1,30}\b(variable|function|file|method|class|name|identifier)s?\b/i,
  /\b(naming|convention|policy|standard|rule|format|guideline)s?\b.{1,40}\b(is|are|must|should|require)\b/i,
  /\b(variable|pointer|function|method|class|file)s?\b.{1,30}\b(must|should|shall|need to)\b.{1,40}\b(start|end|begin|prefix|named)\b/i,
  /\bprefixed?\s+with\b/i,
  /\bsuffixed?\s+with\b/i,
  /\bstart(s|ing)?\s+with\b/i,
  /\bend(s|ing)?\s+with\b/i,
  /our\s+(convention|standard|rule|policy|practice)\b/i,
  /company\s+(rule|policy|standard|mandate|requirement)\b/i,
];

export function detectImplicitRule(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 8) {
    return false;
  }
  for (const pattern of IMPLICIT_RULE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

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
  return detectImplicitRule(trimmed);
}

export interface KnowledgeCaptureRecord {
  entry: LogMemoryEntry;
  knowledgeFilePath: string;
  // True when the content already existed in KNOWLEDGE.md and was not written again.
  alreadyExisted?: boolean;
}

// Captures engineer-supplied knowledge straight into the semantic layer
// (KNOWLEDGE.md). Entries are pinned by default so they never decay and are
// never consumed by the dream cycle. Embedding is not stored — query()
// recomputes when needed.
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

  private async findSemanticDuplicate(content: string): Promise<LogMemoryEntry | null> {
    const needle = content.trim().toLowerCase();
    const entries = await this.opts.store.loadSemantic();
    return entries.find((e) => e.payload.content.trim().toLowerCase() === needle) ?? null;
  }

  async maybeCapture(input: {
    message: string;
    tags?: string[];
    title?: string;
    // Override the default pinned=true for captures that are allowed to decay.
    pinned?: boolean;
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
    // All captures are pinned by default. Pass pinned: false only for
    // knowledge that should participate in normal decay and dream cycles.
    pinned?: boolean;
  }): Promise<KnowledgeCaptureRecord> {
    // Dedup: return the existing entry without writing if the same content is
    // already in KNOWLEDGE.md. Comparison is trimmed + lowercased to survive
    // minor whitespace differences.
    const duplicate = await this.findSemanticDuplicate(input.message);
    if (duplicate) {
      return {
        entry: duplicate,
        knowledgeFilePath: this.opts.store.semanticPath(),
        alreadyExisted: true,
      };
    }
    const now = this.now();
    const isImplicitRule = detectImplicitRule(input.message);
    const type = isImplicitRule ? "conversation_rule" : "engineer_knowledge";
    const tags = ["source:engineer_teach", ...(input.tags ?? [])];
    if (isImplicitRule) {
      tags.push("auto:implicit_rule");
    }
    const id = computeEntryId({ timestamp: now, service: "engineer", message: input.message });
    const pinned = input.pinned ?? true;
    const entry: LogMemoryEntry = {
      id,
      timestamp: now,
      layer: "semantic",
      payload: {
        type,
        content: input.message,
        tags,
        source: "engineer_teach",
        decayScore: 0.95,
        pinned,
        accessCount: 0,
        lastAccessedAt: now,
        title: input.title,
      },
    };
    await this.opts.store.appendSemantic(entry);
    return { entry, knowledgeFilePath: this.opts.store.semanticPath() };
  }
}
