/**
 * Semantic skill indexing for context-aware dynamic skill loading.
 *
 * Reduces token consumption by loading only relevant skills based on semantic
 * search against user messages, rather than loading ALL skills into context.
 *
 * @module agents/skills/semantic-index
 */

import type { Skill } from "@mariozechner/pi-coding-agent";
import type { SkillEntry } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("skills:semantic");

/**
 * Indexed skill entry with embedding for semantic search.
 */
export interface SkillIndexEntry {
  name: string;
  description: string;
  /** Trigger phrases from SKILL.md metadata */
  triggers: string[];
  /** Embedding vector for semantic similarity */
  embedding: number[];
  /** Path to SKILL.md file */
  filePath: string;
  /** Original skill entry reference */
  entry: SkillEntry;
}

/**
 * Configuration for semantic skill loading.
 */
export interface SemanticSkillConfig {
  /** Enable dynamic skill loading (default: false) */
  enabled: boolean;
  /** Number of skills to load based on relevance (default: 5) */
  topK: number;
  /** Minimum similarity score threshold (0-1, default: 0.3) */
  minScore: number;
  /** Embedding model to use (default: "text-embedding-3-small") */
  embeddingModel?: string;
}

/**
 * In-memory skill index for semantic search.
 */
export class SkillSemanticIndex {
  private index: Map<string, SkillIndexEntry> = new Map();
  private config: Required<SemanticSkillConfig>;

  constructor(config?: Partial<SemanticSkillConfig>) {
    this.config = {
      enabled: config?.enabled ?? false,
      topK: config?.topK ?? 5,
      minScore: config?.minScore ?? 0.3,
      embeddingModel: config?.embeddingModel ?? "text-embedding-3-small",
    };
  }

  /**
   * Build index from skill entries.
   *
   * @param entries - Skill entries to index
   * @param embedFn - Function to generate embeddings
   */
  async buildIndex(
    entries: SkillEntry[],
    embedFn: (text: string) => Promise<number[]>,
  ): Promise<void> {
    logger.info(`Building semantic skill index for ${entries.length} skills...`);

    const start = Date.now();
    let indexed = 0;

    for (const entry of entries) {
      try {
        const description = this.extractDescription(entry);
        const triggers = this.extractTriggers(entry);

        // Combine description + triggers for embedding
        const text = [description, ...triggers].filter(Boolean).join(" ");

        if (!text.trim()) {
          logger.debug(`Skipping skill ${entry.skill.name} (no description/triggers)`);
          continue;
        }

        const embedding = await embedFn(text);

        this.index.set(entry.skill.name, {
          name: entry.skill.name,
          description,
          triggers,
          embedding,
          filePath: entry.skill.filePath,
          entry,
        });

        indexed++;
      } catch (error) {
        logger.error(
          `Failed to index skill ${entry.skill.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const duration = Date.now() - start;
    logger.info(`Indexed ${indexed}/${entries.length} skills in ${duration}ms`);
  }

  /**
   * Search for relevant skills based on user message.
   *
   * @param query - User message to search against
   * @param embedFn - Function to generate query embedding
   * @param topK - Number of results to return (overrides config)
   * @returns Top-k most relevant skill entries
   */
  async search(
    query: string,
    embedFn: (text: string) => Promise<number[]>,
    topK?: number,
  ): Promise<SkillEntry[]> {
    if (this.index.size === 0) {
      logger.warn("Skill index is empty, returning no results");
      return [];
    }

    const k = topK ?? this.config.topK;
    const queryEmbedding = await embedFn(query);

    // Calculate cosine similarity for all skills
    const scores = Array.from(this.index.values()).map((indexed) => ({
      entry: indexed.entry,
      score: this.cosineSimilarity(queryEmbedding, indexed.embedding),
      name: indexed.name,
    }));

    // Sort by score descending and filter by threshold
    const relevant = scores
      .filter((s) => s.score >= this.config.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    logger.debug(
      `Found ${relevant.length} relevant skills for query (threshold: ${this.config.minScore})`,
      { topSkills: relevant.slice(0, 3).map((s) => `${s.name} (${s.score.toFixed(3)})`) },
    );

    return relevant.map((s) => s.entry);
  }

  /**
   * Get lightweight directory of all indexed skills (name + description).
   */
  getSkillDirectory(): Array<{ name: string; description: string }> {
    return Array.from(this.index.values()).map((indexed) => ({
      name: indexed.name,
      description: indexed.description,
    }));
  }

  /**
   * Get full skill entry by name (for lazy loading).
   */
  getSkillEntry(name: string): SkillEntry | undefined {
    return this.index.get(name)?.entry;
  }

  /**
   * Calculate cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Vectors must have same length");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /**
   * Extract skill description from metadata.
   */
  private extractDescription(entry: SkillEntry): string {
    // Try frontmatter description first
    if (entry.frontmatter.description) {
      return entry.frontmatter.description;
    }

    // Fall back to skill.description from SKILL.md
    const skill = entry.skill as Skill & { description?: string };
    return skill.description || entry.skill.name;
  }

  /**
   * Extract trigger phrases from metadata.
   */
  private extractTriggers(entry: SkillEntry): string[] {
    const metadata = entry.metadata;
    if (!metadata) {
      return [];
    }

    // Parse trigger phrases from frontmatter
    // Format: triggers: ["phrase 1", "phrase 2"] or triggers: "phrase 1, phrase 2"
    const raw = entry.frontmatter.triggers;

    // Handle array format (YAML parses arrays directly)
    if (Array.isArray(raw)) {
      return raw.filter((t): t is string => typeof t === "string");
    }

    // Handle string format (JSON or comma-separated)
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        // Fall back to comma-separated
        return raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
    }

    return [];
  }

  /**
   * Get index statistics.
   */
  getStats(): {
    totalSkills: number;
    config: Required<SemanticSkillConfig>;
  } {
    return {
      totalSkills: this.index.size,
      config: this.config,
    };
  }
}

/**
 * Create an embedding function using OpenAI's API.
 *
 * @param apiKey - OpenAI API key
 * @param model - Embedding model name (default: "text-embedding-3-small")
 * @returns Embedding function
 */
export function createOpenAIEmbedFn(
  apiKey: string,
  model = "text-embedding-3-small",
): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    if (!data.data?.[0]?.embedding) {
      throw new Error("No embedding returned from OpenAI API");
    }
    return data.data[0].embedding;
  };
}

/**
 * Create an embedding function using Anthropic's API (via Voyage AI).
 * Note: Anthropic uses Voyage AI for embeddings.
 *
 * @param apiKey - Voyage AI API key
 * @param model - Embedding model name (default: "voyage-3-lite")
 * @returns Embedding function
 */
export function createVoyageEmbedFn(
  apiKey: string,
  model = "voyage-3-lite",
): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage AI embedding failed: ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    if (!data.data?.[0]?.embedding) {
      throw new Error("No embedding returned from Voyage AI API");
    }
    return data.data[0].embedding;
  };
}

/**
 * Resolve embed function from configuration.
 *
 * @param provider - Provider name ("openai" | "voyage" | "anthropic")
 * @param apiKey - API key for the provider
 * @param model - Optional model name override
 * @returns Configured embedding function
 */
export function resolveEmbedFn(
  provider: string,
  apiKey: string,
  model?: string,
): (text: string) => Promise<number[]> {
  switch (provider.toLowerCase()) {
    case "openai":
      return createOpenAIEmbedFn(apiKey, model ?? "text-embedding-3-small");
    case "voyage":
    case "anthropic":
      return createVoyageEmbedFn(apiKey, model ?? "voyage-3-lite");
    default:
      throw new Error(
        `Unknown embedding provider: ${provider}. ` +
          "Supported providers: openai, voyage, anthropic",
      );
  }
}

/**
 * Default embed function placeholder.
 * Real implementation should use OpenAI/Anthropic embeddings.
 */
export async function defaultEmbedFn(text: string): Promise<number[]> {
  // TODO: Implement with @mariozechner/pi-ai embeddings
  throw new Error(
    "Semantic skill indexing requires an embedding function. " +
      "Configure skills.dynamicLoading.embeddingProvider in config.",
  );
}
