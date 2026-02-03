/**
 * Hybrid retriever for docs-chat RAG pipeline.
 * Combines vector similarity with keyword boosting for improved relevance.
 */
import { Embeddings } from "./embeddings.js";
import { DocsStore, type DocsChunk, type SearchResult } from "./store.js";

export interface RetrievalResult {
  chunk: Omit<DocsChunk, "vector">;
  score: number;
}

export class Retriever {
  constructor(
    private readonly store: DocsStore,
    private readonly embeddings: Embeddings,
  ) { }

  /**
   * Retrieve relevant chunks using hybrid scoring:
   * - Primary: vector similarity search
   * - Secondary: keyword boost for exact term matches
   */
  async retrieve(query: string, limit: number = 8): Promise<RetrievalResult[]> {
    // Generate query embedding
    const queryVector = await this.embeddings.embed(query);

    // Over-fetch for reranking (2x limit)
    const searchResults = await this.store.search(queryVector, limit * 2);

    if (searchResults.length === 0) {
      return [];
    }

    // Apply hybrid scoring
    const scored = searchResults.map((result) => ({
      chunk: result.chunk,
      score: this.hybridScore(result.similarity, query, result.chunk),
    }));

    // Sort by hybrid score and take top-k
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((item) => ({
      chunk: {
        id: item.chunk.id,
        path: item.chunk.path,
        title: item.chunk.title,
        content: item.chunk.content,
        url: item.chunk.url,
      },
      score: item.score,
    }));
  }

  /**
   * Compute hybrid score combining vector similarity and keyword boost.
   */
  private hybridScore(
    vectorSimilarity: number,
    query: string,
    chunk: DocsChunk,
  ): number {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const text = `${chunk.title} ${chunk.content}`.toLowerCase();

    // Count matching words and apply boost
    const matchingWords = words.filter((word) => text.includes(word));
    const keywordBoost = matchingWords.length * 0.05;

    return vectorSimilarity + keywordBoost;
  }
}
