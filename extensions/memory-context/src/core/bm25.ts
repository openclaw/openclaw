/**
 * BM25 (Best Matching 25) keyword search implementation.
 *
 * Pure TypeScript, no external dependencies.
 * Supports incremental document addition.
 */

export type BM25SearchResult = { id: string; score: number };

/**
 * Simple tokenizer: splits on whitespace and punctuation, handles CJK with
 * unigram + bigram strategy for better compound-word matching.
 *
 * CJK bigrams dramatically improve Chinese recall:
 *   "飞书消息" → ["飞", "飞书", "书", "书消", "消", "消息", "息"]
 * The bigrams "飞书" and "消息" carry IDF weight, so documents containing
 * the exact compound get a relevance boost over character-level overlap.
 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  let prevCJK = ""; // previous CJK char for bigram generation

  let current = "";
  for (const char of normalized) {
    // Check if it's a CJK character (Chinese, Japanese, Korean)
    const code = char.codePointAt(0) ?? 0;
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f); // CJK Symbols and Punctuation

    if (isCJK) {
      // Flush current token
      if (current.length > 0) {
        tokens.push(current);
        current = "";
        prevCJK = ""; // non-CJK breaks bigram chain
      }
      // Unigram
      tokens.push(char);
      // Bigram with previous CJK character
      if (prevCJK) {
        tokens.push(prevCJK + char);
      }
      prevCJK = char;
    } else if (/[\s\p{P}]/u.test(char)) {
      // Whitespace or punctuation - flush current token
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      prevCJK = ""; // separator breaks bigram chain
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      // Letter or number - add to current token
      current += char;
      prevCJK = ""; // non-CJK breaks bigram chain
    }
  }

  // Flush remaining
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * BM25 index for keyword-based search.
 *
 * Parameters:
 * - k1: term frequency saturation (default: 1.2)
 * - b: length normalization (default: 0.75)
 */
export class BM25Index {
  private readonly k1: number;
  private readonly b: number;

  // Document storage: id -> tokens
  private readonly docs = new Map<string, string[]>();

  // Inverted index: term -> Set<docId>
  private readonly invertedIndex = new Map<string, Set<string>>();

  // Term frequency per document: docId -> (term -> count)
  private readonly termFreqs = new Map<string, Map<string, number>>();

  // Document lengths
  private readonly docLengths = new Map<string, number>();

  // Stats
  private totalDocLength = 0;
  private docCount = 0;

  constructor(k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  get size(): number {
    return this.docCount;
  }

  /**
   * Add or update a document in the index.
   */
  add(id: string, text: string): void {
    // Remove existing if updating
    if (this.docs.has(id)) {
      this.remove(id);
    }

    const tokens = tokenize(text);
    this.docs.set(id, tokens);
    this.docLengths.set(id, tokens.length);
    this.totalDocLength += tokens.length;
    this.docCount++;

    // Build term frequency for this doc
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);

      // Update inverted index
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token)!.add(id);
    }
    this.termFreqs.set(id, tf);
  }

  /**
   * Remove a document from the index.
   */
  remove(id: string): boolean {
    const tokens = this.docs.get(id);
    if (!tokens) {
      return false;
    }

    // Remove from inverted index
    const tf = this.termFreqs.get(id);
    if (tf) {
      for (const term of tf.keys()) {
        const docSet = this.invertedIndex.get(term);
        if (docSet) {
          docSet.delete(id);
          if (docSet.size === 0) {
            this.invertedIndex.delete(term);
          }
        }
      }
    }

    // Update stats
    const docLen = this.docLengths.get(id) ?? 0;
    this.totalDocLength -= docLen;
    this.docCount--;

    // Remove from storage
    this.docs.delete(id);
    this.termFreqs.delete(id);
    this.docLengths.delete(id);

    return true;
  }

  /**
   * Check if a document exists.
   */
  has(id: string): boolean {
    return this.docs.has(id);
  }

  /**
   * Search for documents matching the query.
   * Returns results sorted by BM25 score (highest first).
   */
  search(query: string, topK = 10): BM25SearchResult[] {
    if (this.docCount === 0) {
      return [];
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return [];
    }

    const avgDocLen = this.totalDocLength / this.docCount;
    const scores = new Map<string, number>();

    for (const term of queryTokens) {
      const docSet = this.invertedIndex.get(term);
      if (!docSet) {
        continue;
      }

      // IDF: log((N - n + 0.5) / (n + 0.5) + 1)
      const n = docSet.size;
      const idf = Math.log((this.docCount - n + 0.5) / (n + 0.5) + 1);

      for (const docId of docSet) {
        const tf = this.termFreqs.get(docId)?.get(term) ?? 0;
        const docLen = this.docLengths.get(docId) ?? 0;

        // BM25 score for this term in this doc
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
        const termScore = idf * (numerator / denominator);

        scores.set(docId, (scores.get(docId) ?? 0) + termScore);
      }
    }

    // Sort by score and return top K
    const results: BM25SearchResult[] = [];
    for (const [id, score] of scores.entries()) {
      results.push({ id, score });
    }
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, Math.max(0, topK));
  }

  /**
   * Get the raw tokens for a document (for debugging).
   */
  getTokens(id: string): string[] | undefined {
    return this.docs.get(id);
  }
}
