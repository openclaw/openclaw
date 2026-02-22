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

  /** IDF cache: token → idf score.  Invalidated when fact count changes. */
  private idfCache: Map<string, number> | null = null;
  private idfCacheFactCount = 0;

  /**
   * Minimal CJK safety stop-words — only particles/pronouns that are NEVER
   * meaningful as search keywords.  Kept small on purpose; the IDF weighting
   * handles the rest automatically.
   */
  private static readonly CJK_STOP = new Set([
    "的",
    "是",
    "了",
    "在",
    "我",
    "你",
    "他",
    "她",
    "它",
    "也",
    "都",
    "就",
    "和",
    "有",
    "这",
    "那",
    "不",
    "会",
    "到",
    "着",
    "过",
    "得",
    "地",
    "吗",
    "呢",
    "吧",
    "啊",
    "么",
    "与",
    "及",
    "把",
    "被",
    "让",
    "之",
    "其",
  ]);

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.filePath = path.join(storagePath, "knowledge.jsonl");
  }

  private contentHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 16);
  }

  /**
   * Jaccard similarity between two texts using CJK-aware tokenization.
   * Returns 0-1 where 1 means identical token sets.
   */
  private static jaccard(a: string, b: string): number {
    const ta = new Set(KnowledgeStore.tokenize(a));
    const tb = new Set(KnowledgeStore.tokenize(b));
    if (ta.size === 0 || tb.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const t of ta) {
      if (tb.has(t)) {
        intersection++;
      }
    }
    return intersection / (ta.size + tb.size - intersection);
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
   * Uses two-level dedup:
   *  1. Exact content hash — identical text after trim+lowercase
   *  2. Fuzzy Jaccard — same type, token-set similarity > 0.8 → supersede older
   */
  async add(input: {
    type: KnowledgeFactType;
    content: string;
    context?: string;
  }): Promise<KnowledgeFact> {
    await this.init();

    // Level 1: Exact content hash dedup
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

    // Level 2: Fuzzy dedup — find same-type fact with Jaccard > 0.8
    // Supersede the older fact so the newer (presumably more accurate) one wins.
    const FUZZY_THRESHOLD = 0.8;
    let supersededId: string | undefined;
    for (const [id, f] of this.facts) {
      if (f.supersededBy || f.type !== input.type) {
        continue;
      }
      if (KnowledgeStore.jaccard(f.content, input.content) >= FUZZY_THRESHOLD) {
        supersededId = id;
        break;
      }
    }

    this.facts.set(fact.id, fact);
    this.contentIndex.set(hash, fact.id);
    this.invalidateIdf();
    await this.appendLine(fact);

    // Supersede after adding so the new fact ID is available
    if (supersededId) {
      await this.supersede(supersededId, fact.id);
    }

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
    this.invalidateIdf();
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
    this.invalidateIdf();
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
    this.invalidateIdf();
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
   * Tokenize text into words (whitespace-split) + CJK bigrams.
   * Handles mixed Chinese/English without external dependencies.
   *
   * CJK runs are split into overlapping bigrams (e.g. "工作流程" → ["工作", "作流", "流程"])
   * so that two-character compound words match precisely instead of
   * single characters matching everything.
   * Single-char CJK runs are kept as-is (after stop-word filtering).
   */
  private static tokenize(text: string): string[] {
    const tokens: string[] = [];
    // Match consecutive runs of CJK, or non-CJK words
    const re =
      /([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+)|([^\s\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) {
        // CJK run → overlapping bigrams
        const run = m[1];
        if (run.length === 1) {
          if (!KnowledgeStore.CJK_STOP.has(run)) {
            tokens.push(run);
          }
        } else {
          for (let i = 0; i < run.length - 1; i++) {
            const bigram = run[i] + run[i + 1];
            // Skip bigrams where BOTH chars are stop-words
            if (!KnowledgeStore.CJK_STOP.has(run[i]) || !KnowledgeStore.CJK_STOP.has(run[i + 1])) {
              tokens.push(bigram);
            }
          }
        }
      } else if (m[2]) {
        const t = m[2].toLowerCase();
        if (t) {
          tokens.push(t);
        }
      }
    }
    return tokens;
  }

  // ── IDF helpers ──────────────────────────────────────────────────────────

  /**
   * Lazily compute IDF (Inverse Document Frequency) from all active facts.
   * Cached and invalidated when the number of facts changes (add/supersede).
   *
   * IDF(t) = ln((N + 1) / (df(t) + 1))
   *   where N = number of active facts, df(t) = facts containing token t.
   *
   * Tokens appearing in most facts get IDF → 0, rare tokens get high IDF.
   */
  private getIdf(): Map<string, number> {
    const activeCount = this.size;
    if (this.idfCache && this.idfCacheFactCount === activeCount) {
      return this.idfCache;
    }

    const df = new Map<string, number>();
    let N = 0;
    for (const f of this.facts.values()) {
      if (f.supersededBy) {
        continue;
      }
      N++;
      const text = `${f.content} ${f.context ?? ""}`.toLowerCase();
      const seen = new Set(KnowledgeStore.tokenize(text));
      for (const t of seen) {
        df.set(t, (df.get(t) || 0) + 1);
      }
    }

    const idf = new Map<string, number>();
    for (const [token, count] of df) {
      idf.set(token, Math.log((N + 1) / (count + 1)));
    }

    this.idfCache = idf;
    this.idfCacheFactCount = activeCount;
    return idf;
  }

  /** Invalidate IDF cache (call after add/update/supersede). */
  private invalidateIdf(): void {
    this.idfCache = null;
  }

  /**
   * Search facts by keyword with CJK-aware tokenization, IDF-weighted scoring,
   * and adaptive minimum-score filtering.
   *
   * Improvements over simple match-count:
   *  1. CJK stop-words are filtered out of query tokens.
   *  2. Each token is weighted by IDF — common tokens contribute little,
   *     rare/meaningful tokens dominate the score.
   *  3. Adaptive minimum score threshold — lowered for short queries (1-2
   *     effective tokens) to prevent zero-result recall on conversational input.
   */
  search(query: string, limit = 25): KnowledgeFact[] {
    const queryTokens = [...new Set(KnowledgeStore.tokenize(query))];
    if (queryTokens.length === 0) {
      return [];
    }

    const idf = this.getIdf();

    // Only keep query tokens that appear in at least one fact.
    // Unknown tokens (e.g. noise CJK bigrams crossing word boundaries like
    // "钱吧", "在怎") can never match anything and would inflate totalWeight,
    // diluting scores for genuinely relevant tokens.
    const tokenWeights = queryTokens
      .filter((t) => idf.has(t))
      .map((t) => ({
        token: t,
        weight: idf.get(t)!,
      }));

    // Total possible weight (for normalizing score to 0-1)
    const totalWeight = tokenWeights.reduce((s, tw) => s + tw.weight, 0);
    if (totalWeight <= 0) {
      return []; // all query tokens are ultra-common → no useful search
    }

    // Adaptive minimum score based on effective query-token count.
    // Short queries have few tokens after CJK bigram tokenization + IDF
    // filtering, making it nearly impossible to reach a 0.5 threshold.
    // Lower the bar for short queries so single-token matches still surface.
    const nTokens = tokenWeights.length;
    const minScore = nTokens <= 1 ? 0.15 : nTokens <= 2 ? 0.3 : 0.5;

    const scored: { fact: KnowledgeFact; score: number }[] = [];
    for (const f of this.facts.values()) {
      if (f.supersededBy) {
        continue;
      }
      const text = `${f.content} ${f.context ?? ""}`.toLowerCase();
      let matchWeight = 0;
      for (const { token, weight } of tokenWeights) {
        if (text.includes(token)) {
          matchWeight += weight;
        }
      }
      const score = matchWeight / totalWeight;
      if (score >= minScore) {
        scored.push({ fact: f, score });
      }
    }

    // Sort by IDF-weighted score descending, then by recency
    scored.sort((a, b) => b.score - a.score || b.fact.timestamp - a.fact.timestamp);

    // When the threshold is low (short queries), cap results more tightly
    // to avoid flooding with marginally-relevant facts.
    const effectiveLimit = nTokens <= 2 ? Math.min(limit, 10) : limit;
    return scored.slice(0, effectiveLimit).map((s) => s.fact);
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
