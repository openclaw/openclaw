/**
 * Working Memory Buffer ("Short-term Memory")
 *
 * RAM-based cyclic buffer that acts as a filter before long-term storage.
 * Like human short-term memory: only important things get "promoted" to LTM.
 *
 * Promotion criteria:
 * 1. importance > threshold (0.7 default)
 * 2. Mentioned/recalled 3+ times (frequency)
 * 3. Explicit user request ("remember this")
 * 4. Contains entity (email, phone, name)
 *
 * Benefits:
 * - Reduces API calls (fewer embeddings for trivial messages)
 * - Keeps LTM clean (no "ok", "thanks", "lol" in database)
 * - Faster recall (smaller, higher-quality database)
 */

// ============================================================================
// Types
// ============================================================================

export interface BufferEntry {
  text: string;
  importance: number;
  category: string;
  timestamp: number;
  mentionCount: number;
  promoted: boolean;
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
}

// ============================================================================
// Working Memory Buffer
// ============================================================================

export class WorkingMemoryBuffer {
  private buffer: BufferEntry[] = [];
  private readonly maxSize: number;
  private readonly importanceThreshold: number;
  private readonly mentionThreshold: number;

  constructor(maxSize = 50, importanceThreshold = 0.7, mentionThreshold = 3) {
    this.maxSize = maxSize;
    this.importanceThreshold = importanceThreshold;
    this.mentionThreshold = mentionThreshold;
  }

  /**
   * Add a new entry to the buffer.
   * If buffer is full, evicts the oldest non-promoted entry.
   * Returns promotion decision.
   */
  add(text: string, importance: number, category: string): PromotionResult {
    // Check for similar entry already in buffer (boost mention count)
    const existing = this.findSimilar(text);
    if (existing) {
      existing.mentionCount++;
      existing.importance = Math.max(existing.importance, importance);

      // Check if repeated mentions trigger promotion
      if (existing.mentionCount >= this.mentionThreshold && !existing.promoted) {
        existing.promoted = true;
        return {
          promoted: true,
          reason: `mentioned ${existing.mentionCount} times (frequency threshold)`,
        };
      }

      return { promoted: false, reason: "already in buffer, count incremented" };
    }

    // Create new entry
    const entry: BufferEntry = {
      text,
      importance,
      category,
      timestamp: Date.now(),
      mentionCount: 1,
      promoted: false,
    };

    // Check immediate promotion criteria
    const promotion = this.shouldPromote(entry);
    if (promotion.promoted) {
      entry.promoted = true;
    }

    // Evict oldest if full
    if (this.buffer.length >= this.maxSize) {
      this.evictOldest();
    }

    this.buffer.push(entry);
    return promotion;
  }

  /**
   * Force promote an entry (user said "remember this").
   */
  forcePromote(text: string): PromotionResult {
    const existing = this.findSimilar(text);
    if (existing) {
      existing.promoted = true;
      return { promoted: true, reason: "explicit user request" };
    }

    // Not in buffer, add and promote
    const entry: BufferEntry = {
      text,
      importance: 0.9,
      category: "other",
      timestamp: Date.now(),
      mentionCount: 1,
      promoted: true,
    };

    if (this.buffer.length >= this.maxSize) {
      this.evictOldest();
    }

    this.buffer.push(entry);
    return { promoted: true, reason: "explicit user request" };
  }

  /**
   * Check if entry should be immediately promoted to LTM.
   */
  private shouldPromote(entry: BufferEntry): PromotionResult {
    // High importance
    if (entry.importance >= this.importanceThreshold) {
      return {
        promoted: true,
        reason: `high importance (${entry.importance.toFixed(2)} >= ${this.importanceThreshold})`,
      };
    }

    // Entity category (emails, phones, names are always important)
    if (entry.category === "entity") {
      return {
        promoted: true,
        reason: "contains entity (always promoted)",
      };
    }

    // Decision category
    if (entry.category === "decision") {
      return {
        promoted: true,
        reason: "contains decision (always promoted)",
      };
    }

    return { promoted: false, reason: "below threshold, staying in buffer" };
  }

  /**
   * Calculate Levenshtein distance between two strings.
   * (Number of edits required to transform one string to another)
   */
  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
    for (let i = 0; i <= a.length; i++) matrix[0][i] = i;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            Math.min(
              matrix[i][j - 1] + 1, // insertion
              matrix[i - 1][j] + 1, // deletion
            ),
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Find a similar entry in the buffer using fuzzy matching.
   */
  private findSimilar(text: string): BufferEntry | undefined {
    const normalized = text.toLowerCase().trim();

    return this.buffer.find((entry) => {
      const entryNorm = entry.text.toLowerCase().trim();

      // 1. Exact match (Fastest)
      if (entryNorm === normalized) return true;

      // 2. Substring match (Fast)
      if (normalized.length > 20 && entryNorm.length > 20) {
        if (normalized.includes(entryNorm) || entryNorm.includes(normalized)) {
          return true;
        }
      }

      // 3. Levenshtein Distance (Slowest but smartest)
      // Only run if lengths are somewhat close
      if (Math.abs(normalized.length - entryNorm.length) < 10) {
        const dist = this.levenshteinDistance(normalized, entryNorm);
        const maxLength = Math.max(normalized.length, entryNorm.length);

        // Match if < 20% difference (80% similarity)
        // e.g. "I love AI" vs "I like AI" -> dist 2, len 9 -> 2/9 = 0.22 (no match)
        // "My name is Vova" vs "My name is Pova" -> dist 1, len 15 -> 1/15 = 0.06 (match)
        if (dist / maxLength < 0.2) {
          return true;
        }
      }

      return false;
    });
  }

  /**
   * Evict the oldest non-promoted entry.
   * If all are promoted, evict the oldest promoted entry.
   */
  private evictOldest(): void {
    const nonPromotedIdx = this.buffer.findIndex((e) => !e.promoted);
    if (nonPromotedIdx !== -1) {
      this.buffer.splice(nonPromotedIdx, 1);
    } else if (this.buffer.length > 0) {
      this.buffer.shift();
    }
  }

  /** Get all entries currently in the buffer */
  get entries(): readonly BufferEntry[] {
    return this.buffer;
  }

  /** Get buffer size */
  get size(): number {
    return this.buffer.length;
  }

  /** Get count of promoted entries */
  get promotedCount(): number {
    return this.buffer.filter((e) => e.promoted).length;
  }

  /** Clear the buffer */
  clear(): void {
    this.buffer = [];
  }

  /** Get buffer stats */
  stats(): {
    total: number;
    promoted: number;
    pending: number;
    avgImportance: number;
  } {
    const promoted = this.buffer.filter((e) => e.promoted).length;
    const avgImportance =
      this.buffer.length > 0
        ? this.buffer.reduce((sum, e) => sum + e.importance, 0) / this.buffer.length
        : 0;

    return {
      total: this.buffer.length,
      promoted,
      pending: this.buffer.length - promoted,
      avgImportance: Math.round(avgImportance * 100) / 100,
    };
  }
}
