/**
 * Knowledge Store -- stores extracted technical facts from compacted conversations.
 *
 * Each fact is a short, structured record (decision, implementation, config, etc.).
 * Supports ADD, UPDATE, supersede (soft delete), and search by keyword/embedding.
 * Persisted as a JSONL file (knowledge.jsonl).
 */
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export type KnowledgeFactType =
  | "decision"
  | "implementation"
  | "config"
  | "issue"
  | "task_state"
  | "architecture";

export type KnowledgeFact = {
  id: string;
  type: KnowledgeFactType;
  content: string;
  context?: string;
  timestamp: number;
  supersededBy?: string; // ID of the fact that replaced this one
};

type StoredFact = KnowledgeFact & { _deleted?: boolean };

export class KnowledgeStore {
  private readonly facts = new Map<string, KnowledgeFact>();
  private readonly contentIndex = new Map<string, string>(); // contentHash -> factId
  private readonly filePath: string;
  private readonly storagePath: string;
  private appendChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.filePath = path.join(storagePath, "knowledge.jsonl");
  }

  private contentHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 16);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await fs.mkdir(this.storagePath, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, "", "utf8");
    }

    // Stream-load existing facts
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const obj = JSON.parse(trimmed) as StoredFact;
          if (!obj?.id || !obj?.content || !obj?.type) {
            continue;
          }
          if (obj._deleted) {
            this.facts.delete(obj.id);
            continue;
          }
          this.facts.set(obj.id, {
            id: obj.id,
            type: obj.type,
            content: obj.content,
            context: obj.context,
            timestamp: obj.timestamp ?? Date.now(),
            supersededBy: obj.supersededBy,
          });
          this.contentIndex.set(this.contentHash(obj.content), obj.id);
        } catch {
          continue;
        }
      }
    } finally {
      stream.destroy();
    }
    this.initialized = true;
  }

  get size(): number {
    // Only count active (non-superseded) facts
    let count = 0;
    for (const f of this.facts.values()) {
      if (!f.supersededBy) {
        count++;
      }
    }
    return count;
  }

  get totalSize(): number {
    return this.facts.size;
  }

  private async appendLine(obj: StoredFact): Promise<void> {
    const line = JSON.stringify(obj);
    this.appendChain = this.appendChain.then(async () => {
      await fs.appendFile(this.filePath, `${line}\n`, "utf8");
    });
    return this.appendChain;
  }

  /**
   * Add a new fact. Returns the fact if added, or the existing one if duplicate.
   */
  async add(input: {
    type: KnowledgeFactType;
    content: string;
    context?: string;
  }): Promise<KnowledgeFact> {
    await this.init();

    // Dedup by content hash
    const hash = this.contentHash(input.content);
    const existingId = this.contentIndex.get(hash);
    if (existingId) {
      const existing = this.facts.get(existingId);
      if (existing && !existing.supersededBy) {
        return existing;
      }
    }

    const fact: KnowledgeFact = {
      id: randomUUID(),
      type: input.type,
      content: input.content,
      context: input.context,
      timestamp: Date.now(),
    };

    this.facts.set(fact.id, fact);
    this.contentIndex.set(hash, fact.id);
    await this.appendLine(fact);
    return fact;
  }

  /**
   * Update an existing fact's content. Keeps the same ID.
   */
  async update(id: string, newContent: string, newContext?: string): Promise<KnowledgeFact | null> {
    await this.init();
    const existing = this.facts.get(id);
    if (!existing) {
      return null;
    }

    // Remove old content hash
    const oldHash = this.contentHash(existing.content);
    this.contentIndex.delete(oldHash);

    const updated: KnowledgeFact = {
      ...existing,
      content: newContent,
      context: newContext ?? existing.context,
      timestamp: Date.now(),
    };

    this.facts.set(id, updated);
    this.contentIndex.set(this.contentHash(newContent), id);
    await this.appendLine(updated);
    return updated;
  }

  /**
   * Mark a fact as superseded by another fact (soft delete).
   * The fact remains in storage but is excluded from active queries.
   */
  async supersede(oldId: string, newId: string): Promise<boolean> {
    await this.init();
    const existing = this.facts.get(oldId);
    if (!existing) {
      return false;
    }

    const updated: KnowledgeFact = { ...existing, supersededBy: newId };
    this.facts.set(oldId, updated);
    await this.appendLine(updated);
    return true;
  }

  /**
   * Hard delete a fact (only when allowDelete is explicitly enabled).
   */
  async delete(id: string): Promise<boolean> {
    await this.init();
    const existing = this.facts.get(id);
    if (!existing) {
      return false;
    }

    this.facts.delete(id);
    const hash = this.contentHash(existing.content);
    this.contentIndex.delete(hash);
    await this.appendLine({ ...existing, _deleted: true } as StoredFact);
    return true;
  }

  /**
   * Get a fact by ID.
   */
  get(id: string): KnowledgeFact | undefined {
    return this.facts.get(id);
  }

  /**
   * Get all active (non-superseded) facts, optionally filtered by type.
   */
  getActive(type?: KnowledgeFactType): KnowledgeFact[] {
    const result: KnowledgeFact[] = [];
    for (const f of this.facts.values()) {
      if (f.supersededBy) {
        continue;
      }
      if (type && f.type !== type) {
        continue;
      }
      result.push(f);
    }
    return result.toSorted((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Tokenize text into words (whitespace-split) + individual CJK characters.
   * Handles mixed Chinese/English without external dependencies.
   */
  private static tokenize(text: string): string[] {
    const tokens: string[] = [];
    // Match runs of CJK chars individually, or runs of non-CJK non-whitespace as words
    const re =
      /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]|[^\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = m[0].toLowerCase();
      if (t) {
        tokens.push(t);
      }
    }
    return tokens;
  }

  /**
   * Search facts by keyword with CJK-aware tokenization and adaptive threshold.
   * Uses scoring to rank results by match quality.
   */
  search(query: string, limit = 10): KnowledgeFact[] {
    const queryTokens = [...new Set(KnowledgeStore.tokenize(query))];
    if (queryTokens.length === 0) {
      return [];
    }

    // Adaptive threshold: prevents long concatenated queries from requiring too many matches
    let threshold: number;
    if (queryTokens.length <= 2) {
      threshold = 1;
    } else if (queryTokens.length <= 8) {
      threshold = Math.ceil(queryTokens.length * 0.5);
    } else {
      // For long queries (e.g. 3 user messages concatenated): cap threshold
      threshold = Math.min(Math.ceil(queryTokens.length * 0.3), 6);
    }

    const scored: { fact: KnowledgeFact; score: number }[] = [];
    for (const f of this.facts.values()) {
      if (f.supersededBy) {
        continue;
      }
      const text = `${f.content} ${f.context ?? ""}`.toLowerCase();
      const matchCount = queryTokens.filter((w) => text.includes(w)).length;
      if (matchCount >= threshold) {
        scored.push({ fact: f, score: matchCount / queryTokens.length });
      }
    }
    // Sort by match score descending, then by timestamp descending
    scored.sort((a, b) => b.score - a.score || b.fact.timestamp - a.fact.timestamp);
    return scored.slice(0, limit).map((s) => s.fact);
  }

  /**
   * Find an existing fact by similar content (for dedup/update detection).
   */
  findByContent(content: string): KnowledgeFact | undefined {
    const hash = this.contentHash(content);
    const id = this.contentIndex.get(hash);
    if (id) {
      return this.facts.get(id);
    }
    return undefined;
  }

  stats(): { active: number; superseded: number; total: number } {
    let superseded = 0;
    for (const f of this.facts.values()) {
      if (f.supersededBy) {
        superseded++;
      }
    }
    return { active: this.size, superseded, total: this.facts.size };
  }
}
