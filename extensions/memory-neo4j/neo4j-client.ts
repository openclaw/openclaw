/**
 * Neo4j driver wrapper for memory-neo4j plugin.
 *
 * Handles connection management, index creation, CRUD operations,
 * and the three search signals (vector, BM25, graph).
 *
 * Patterns adapted from ~/Downloads/ontology/app/services/neo4j_client.py
 * with retry-on-transient and MERGE idempotency.
 */

import neo4j, { type Driver } from "neo4j-driver";
import { randomUUID } from "node:crypto";
import type {
  ExtractionStatus,
  MergeEntityInput,
  SearchSignalResult,
  StoreMemoryInput,
} from "./schema.js";
import { ALLOWED_RELATIONSHIP_TYPES, escapeLucene, validateRelationshipType } from "./schema.js";

const RELATIONSHIP_TYPE_PATTERN = [...ALLOWED_RELATIONSHIP_TYPES].join("|");

// ============================================================================
// Types
// ============================================================================

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

// Retry configuration for transient Neo4j errors (deadlocks, etc.)
const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

// ============================================================================
// Neo4j Memory Client
// ============================================================================

export class Neo4jMemoryClient {
  private driver: Driver | null = null;
  private initPromise: Promise<void> | null = null;
  private indexesReady = false;

  constructor(
    private readonly uri: string,
    private readonly username: string,
    private readonly password: string,
    private readonly dimensions: number,
    private readonly logger: Logger,
  ) {}

  // --------------------------------------------------------------------------
  // Connection & Initialization
  // --------------------------------------------------------------------------

  async ensureInitialized(): Promise<void> {
    if (this.driver && this.indexesReady) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize().catch((err) => {
      // Reset so subsequent calls retry instead of returning cached rejection
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.username, this.password), {
      disableLosslessIntegers: true,
    });

    // Verify connection
    const session = this.driver.session();
    try {
      await session.run("RETURN 1");
      this.logger.info(`memory-neo4j: connected to ${this.uri}`);
    } finally {
      await session.close();
    }

    // Create indexes
    await this.ensureIndexes();
    this.indexesReady = true;
  }

  private async ensureIndexes(): Promise<void> {
    const session = this.driver!.session();
    try {
      // Uniqueness constraints (also create indexes implicitly)
      await this.runSafe(
        session,
        "CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
      );
      await this.runSafe(
        session,
        "CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
      );
      await this.runSafe(
        session,
        "CREATE CONSTRAINT tag_name_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE",
      );

      // Vector indexes
      await this.runSafe(
        session,
        `
        CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
        FOR (m:Memory) ON m.embedding
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: ${this.dimensions},
          \`vector.similarity_function\`: 'cosine'
        }}
      `,
      );
      // Full-text indexes (Lucene BM25)
      await this.runSafe(
        session,
        "CREATE FULLTEXT INDEX memory_fulltext_index IF NOT EXISTS FOR (m:Memory) ON EACH [m.text]",
      );
      await this.runSafe(
        session,
        "CREATE FULLTEXT INDEX entity_fulltext_index IF NOT EXISTS FOR (e:Entity) ON EACH [e.name]",
      );

      // Property indexes for filtering
      await this.runSafe(
        session,
        "CREATE INDEX memory_agent_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId)",
      );
      await this.runSafe(
        session,
        "CREATE INDEX memory_category_index IF NOT EXISTS FOR (m:Memory) ON (m.category)",
      );
      await this.runSafe(
        session,
        "CREATE INDEX memory_created_index IF NOT EXISTS FOR (m:Memory) ON (m.createdAt)",
      );
      await this.runSafe(
        session,
        "CREATE INDEX memory_retrieved_index IF NOT EXISTS FOR (m:Memory) ON (m.lastRetrievedAt)",
      );
      await this.runSafe(
        session,
        "CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type)",
      );
      await this.runSafe(
        session,
        "CREATE INDEX entity_name_index IF NOT EXISTS FOR (e:Entity) ON (e.name)",
      );
      // Composite index for queries that filter by both agentId and category
      // (e.g. listByCategory, promotion/demotion filtering in sleep cycle)
      await this.runSafe(
        session,
        "CREATE INDEX memory_agent_category_index IF NOT EXISTS FOR (m:Memory) ON (m.agentId, m.category)",
      );

      this.logger.info("memory-neo4j: indexes ensured");
    } finally {
      await session.close();
    }
  }

  /**
   * Run a Cypher statement, logging but not throwing on error.
   * Used for index creation where indexes may already exist with different config.
   */
  private async runSafe(session: ReturnType<Driver["session"]>, query: string): Promise<void> {
    try {
      await session.run(query);
    } catch (err) {
      this.logger.debug?.(`memory-neo4j: index/constraint statement skipped: ${String(err)}`);
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.indexesReady = false;
      this.initPromise = null;
      this.logger.info("memory-neo4j: connection closed");
    }
  }

  /**
   * Run a raw Cypher query and return records as plain objects.
   * Keys in the RETURN clause become object properties.
   */
  async runQuery<T extends Record<string, unknown>>(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(cypher, params);
      return result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        for (const key of r.keys) {
          obj[key as string] = r.get(key as string);
        }
        return obj as T;
      });
    } finally {
      await session.close();
    }
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }
    const session = this.driver.session();
    try {
      await session.run("RETURN 1");
      return true;
    } catch (err) {
      this.logger.error(`memory-neo4j: connection verification failed: ${String(err)}`);
      return false;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------------------------

  async storeMemory(input: StoreMemoryInput): Promise<string> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        const now = new Date().toISOString();
        const result = await session.run(
          `CREATE (m:Memory {
            id: $id, text: $text, embedding: $embedding,
            importance: $importance, category: $category,
            source: $source, extractionStatus: $extractionStatus,
            agentId: $agentId, sessionKey: $sessionKey,
            createdAt: $createdAt, updatedAt: $updatedAt,
            retrievalCount: $retrievalCount, lastRetrievedAt: $lastRetrievedAt,
            extractionRetries: $extractionRetries
          })
          RETURN m.id AS id`,
          {
            ...input,
            sessionKey: input.sessionKey ?? null,
            createdAt: now,
            updatedAt: now,
            retrievalCount: 0,
            lastRetrievedAt: null,
            extractionRetries: 0,
          },
        );
        return result.records[0].get("id") as string;
      } finally {
        await session.close();
      }
    });
  }

  async deleteMemory(id: string, agentId?: string): Promise<boolean> {
    await this.ensureInitialized();
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        // Atomic: decrement mentionCount and delete in a single Cypher statement
        // to prevent inconsistent state if a crash occurs between operations.
        // When agentId is provided, scope the delete to that agent's memories
        // to prevent cross-agent deletion.
        const matchClause = agentId
          ? "MATCH (m:Memory {id: $id, agentId: $agentId})"
          : "MATCH (m:Memory {id: $id})";
        const result = await session.run(
          `${matchClause}
           OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
           SET e.mentionCount = CASE WHEN e.mentionCount > 0 THEN e.mentionCount - 1 ELSE 0 END
           WITH m, count(e) AS _
           DETACH DELETE m
           RETURN count(*) AS deleted`,
          agentId ? { id, agentId } : { id },
        );

        const deleted =
          result.records.length > 0 ? (result.records[0].get("deleted") as number) > 0 : false;
        return deleted;
      } finally {
        await session.close();
      }
    });
  }

  async countMemories(agentId?: string): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const query = agentId
        ? "MATCH (m:Memory {agentId: $agentId}) RETURN count(m) AS count"
        : "MATCH (m:Memory) RETURN count(m) AS count";
      const result = await session.run(query, agentId ? { agentId } : {});
      return (result.records[0]?.get("count") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Get memory counts grouped by agentId and category.
   * Returns stats for building a summary table.
   */
  async getMemoryStats(): Promise<
    Array<{ agentId: string; category: string; count: number; avgImportance: number }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(`
        MATCH (m:Memory)
        RETURN m.agentId AS agentId, m.category AS category,
               count(m) AS count, avg(m.importance) AS avgImportance
        ORDER BY agentId, category
      `);
      return result.records.map((r) => {
        const countVal = r.get("count");
        const avgVal = r.get("avgImportance");
        return {
          agentId: (r.get("agentId") as string) ?? "default",
          category: (r.get("category") as string) ?? "other",
          count: typeof countVal === "number" ? countVal : Number(countVal),
          avgImportance: typeof avgVal === "number" ? avgVal : Number(avgVal),
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * List memories by category, ordered by importance (descending).
   * Used for loading core memories at session start.
   */
  async listByCategory(
    category: string,
    limit: number,
    minImportance: number = 0,
    agentId?: string,
  ): Promise<{ id: string; text: string; category: string; importance: number }[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.category = $category AND m.importance >= $minImportance ${agentFilter}
         RETURN m.id AS id, m.text AS text, m.category AS category, m.importance AS importance
         ORDER BY m.importance DESC
         LIMIT $limit`,
        {
          category,
          minImportance,
          limit: neo4j.int(Math.floor(limit)),
          ...(agentId ? { agentId } : {}),
        },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        category: r.get("category") as string,
        importance: r.get("importance") as number,
      }));
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Search Signals
  // --------------------------------------------------------------------------

  /**
   * Signal 1: HNSW vector similarity search.
   * Returns memories ranked by cosine similarity to the query embedding.
   */
  async vectorSearch(
    embedding: number[],
    limit: number,
    minScore: number = 0.1,
    agentId?: string,
  ): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
          const result = await session.run(
            `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
             YIELD node, score
             WHERE score >= $minScore ${agentFilter}
             RETURN node.id AS id, node.text AS text, node.category AS category,
                    node.importance AS importance, node.createdAt AS createdAt,
                    score AS similarity
             ORDER BY score DESC`,
            {
              embedding,
              limit: neo4j.int(Math.floor(limit)),
              minScore,
              ...(agentId ? { agentId } : {}),
            },
          );

          return result.records.map((r) => ({
            id: r.get("id") as string,
            text: r.get("text") as string,
            category: r.get("category") as string,
            importance: r.get("importance") as number,
            createdAt: String(r.get("createdAt") ?? ""),
            score: r.get("similarity") as number,
          }));
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if vector index isn't ready or all retries exhausted
      this.logger.warn(`memory-neo4j: vector search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Signal 2: Lucene BM25 full-text keyword search.
   * Returns memories ranked by BM25 relevance score.
   */
  async bm25Search(query: string, limit: number, agentId?: string): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    const escaped = escapeLucene(query);
    if (!escaped.trim()) {
      return [];
    }

    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          const agentFilter = agentId ? "AND node.agentId = $agentId" : "";
          const result = await session.run(
            `CALL db.index.fulltext.queryNodes('memory_fulltext_index', $query)
             YIELD node, score
             WHERE true ${agentFilter}
             RETURN node.id AS id, node.text AS text, node.category AS category,
                    node.importance AS importance, node.createdAt AS createdAt,
                    score AS bm25Score
             ORDER BY score DESC
             LIMIT $limit`,
            {
              query: escaped,
              limit: neo4j.int(Math.floor(limit)),
              ...(agentId ? { agentId } : {}),
            },
          );

          // Normalize BM25 scores to 0-1 range (divide by max)
          const records = result.records.map((r) => ({
            id: r.get("id") as string,
            text: r.get("text") as string,
            category: r.get("category") as string,
            importance: r.get("importance") as number,
            createdAt: String(r.get("createdAt") ?? ""),
            rawScore: r.get("bm25Score") as number,
          }));

          if (records.length === 0) {
            return [];
          }
          const maxScore = records[0].rawScore || 1;
          return records.map((r) => ({
            ...r,
            score: r.rawScore / maxScore,
          }));
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if all retries exhausted
      this.logger.warn(`memory-neo4j: BM25 search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Signal 3: Graph traversal search.
   *
   * 1. Find entities matching the query via fulltext index
   * 2. Find memories directly connected to those entities (MENTIONS)
   * 3. 1-hop spreading activation through entity relationships
   *
   * Returns memories with graph-based relevance scores.
   */
  async graphSearch(
    query: string,
    limit: number,
    firingThreshold: number = 0.3,
    agentId?: string,
  ): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    const escaped = escapeLucene(query);
    if (!escaped.trim()) {
      return [];
    }

    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          // Single query: entity fulltext lookup → direct mentions + 1-hop spreading activation
          const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
          const result = await session.run(
            `// Find matching entities via fulltext index
             CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
             YIELD node AS entity, score
             WHERE score >= 0.5
             WITH entity
             ORDER BY score DESC
             LIMIT 5

             // Direct: Entity ← MENTIONS ← Memory
             OPTIONAL MATCH (entity)<-[rm:MENTIONS]-(m:Memory)
             WHERE m IS NOT NULL ${agentFilter}
             WITH m, coalesce(rm.confidence, 1.0) AS directScore, entity
             WHERE m IS NOT NULL

             RETURN m.id AS id, m.text AS text, m.category AS category,
                    m.importance AS importance, m.createdAt AS createdAt,
                    max(directScore) AS graphScore

             UNION

             // Find matching entities via fulltext index (repeated for UNION)
             CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
             YIELD node AS entity, score
             WHERE score >= 0.5
             WITH entity
             ORDER BY score DESC
             LIMIT 5

             // 1-hop: Entity → relationship → Entity ← MENTIONS ← Memory
             OPTIONAL MATCH (entity)-[r1:${RELATIONSHIP_TYPE_PATTERN}]-(e2:Entity)
             WHERE coalesce(r1.confidence, 0.7) >= $firingThreshold
             OPTIONAL MATCH (e2)<-[rm:MENTIONS]-(m:Memory)
             WHERE m IS NOT NULL ${agentFilter}
             WITH m, coalesce(r1.confidence, 0.7) * coalesce(rm.confidence, 1.0) AS hopScore
             WHERE m IS NOT NULL

             RETURN m.id AS id, m.text AS text, m.category AS category,
                    m.importance AS importance, m.createdAt AS createdAt,
                    max(hopScore) AS graphScore`,
            { query: escaped, firingThreshold, ...(agentId ? { agentId } : {}) },
          );

          // Deduplicate by id, keeping highest score
          const byId = new Map<string, SearchSignalResult>();
          for (const record of result.records) {
            const id = record.get("id") as string;
            if (!id) {
              continue;
            }
            const score = record.get("graphScore") as number;
            const existing = byId.get(id);
            if (!existing || score > existing.score) {
              byId.set(id, {
                id,
                text: record.get("text") as string,
                category: record.get("category") as string,
                importance: record.get("importance") as number,
                createdAt: String(record.get("createdAt") ?? ""),
                score,
              });
            }
          }

          return Array.from(byId.values())
            .toSorted((a, b) => b.score - a.score)
            .slice(0, limit);
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // Graceful degradation: return empty if all retries exhausted
      this.logger.warn(`memory-neo4j: graph search failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Find similar memories by vector similarity. Used for deduplication.
   */
  async findSimilar(
    embedding: number[],
    threshold: number = 0.95,
    limit: number = 1,
  ): Promise<Array<{ id: string; text: string; score: number }>> {
    await this.ensureInitialized();
    try {
      return await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          const result = await session.run(
            `CALL db.index.vector.queryNodes('memory_embedding_index', $limit, $embedding)
             YIELD node, score
             WHERE score >= $threshold
             RETURN node.id AS id, node.text AS text, score AS similarity
             ORDER BY score DESC`,
            { embedding, limit: neo4j.int(limit), threshold },
          );

          return result.records.map((r) => ({
            id: r.get("id") as string,
            text: r.get("text") as string,
            score: r.get("similarity") as number,
          }));
        } finally {
          await session.close();
        }
      });
    } catch (err) {
      // If vector index isn't ready or all retries exhausted, return no duplicates (allow store)
      this.logger.debug?.(`memory-neo4j: similarity check failed: ${String(err)}`);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Retrieval Tracking
  // --------------------------------------------------------------------------

  /**
   * Record retrieval events for memories. Called after search/recall.
   * Increments retrievalCount and updates lastRetrievedAt timestamp.
   */
  async recordRetrievals(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        await session.run(
          `UNWIND $ids AS memId
           MATCH (m:Memory {id: memId})
           SET m.retrievalCount = coalesce(m.retrievalCount, 0) + 1,
               m.lastRetrievedAt = $now`,
          { ids: memoryIds, now: new Date().toISOString() },
        );
      } finally {
        await session.close();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Entity & Relationship Operations
  // --------------------------------------------------------------------------

  /**
   * Merge (upsert) an Entity node using MERGE pattern.
   * Idempotent — safe to call multiple times for the same entity name.
   */
  async mergeEntity(input: MergeEntityInput): Promise<{ id: string; name: string }> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        const result = await session.run(
          `MERGE (e:Entity {name: $name})
           ON CREATE SET
             e.id = $id, e.type = $type, e.aliases = $aliases,
             e.description = $description,
             e.firstSeen = $now, e.lastSeen = $now, e.mentionCount = 1
           ON MATCH SET
             e.type = COALESCE($type, e.type),
             e.description = COALESCE($description, e.description),
             e.lastSeen = $now,
             e.mentionCount = e.mentionCount + 1
           RETURN e.id AS id, e.name AS name`,
          {
            id: input.id,
            name: input.name.trim().toLowerCase(),
            type: input.type,
            aliases: input.aliases ?? [],
            description: input.description ?? null,
            now: new Date().toISOString(),
          },
        );
        const record = result.records[0];
        return {
          id: record.get("id") as string,
          name: record.get("name") as string,
        };
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Create a MENTIONS relationship between a Memory and an Entity.
   */
  async createMentions(
    memoryId: string,
    entityName: string,
    role: string = "context",
    confidence: number = 1.0,
  ): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (m:Memory {id: $memoryId})
         MATCH (e:Entity {name: $entityName})
         MERGE (m)-[r:MENTIONS]->(e)
         ON CREATE SET r.role = $role, r.confidence = $confidence`,
        { memoryId, entityName: entityName.trim().toLowerCase(), role, confidence },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Create a typed relationship between two Entity nodes.
   * The relationship type is validated against an allowlist before injection.
   */
  async createEntityRelationship(
    sourceName: string,
    targetName: string,
    relType: string,
    confidence: number = 1.0,
  ): Promise<void> {
    if (!validateRelationshipType(relType)) {
      this.logger.warn(`memory-neo4j: rejected invalid relationship type: ${relType}`);
      return;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (e1:Entity {name: $sourceName})
         MATCH (e2:Entity {name: $targetName})
         MERGE (e1)-[r:${relType}]->(e2)
         ON CREATE SET r.confidence = $confidence, r.createdAt = $now
         ON MATCH SET r.confidence = CASE WHEN $confidence > r.confidence THEN $confidence ELSE r.confidence END`,
        {
          sourceName: sourceName.trim().toLowerCase(),
          targetName: targetName.trim().toLowerCase(),
          confidence,
          now: new Date().toISOString(),
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Merge a Tag node and link it to a Memory.
   */
  async tagMemory(
    memoryId: string,
    tagName: string,
    tagCategory: string,
    confidence: number = 1.0,
  ): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MERGE (t:Tag {name: $tagName})
         ON CREATE SET t.id = $tagId, t.category = $tagCategory, t.createdAt = $now
         WITH t
         MATCH (m:Memory {id: $memoryId})
         MERGE (m)-[r:TAGGED]->(t)
         ON CREATE SET r.confidence = $confidence`,
        {
          memoryId,
          tagName: tagName.trim().toLowerCase(),
          tagId: randomUUID(),
          tagCategory,
          confidence,
          now: new Date().toISOString(),
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Update a memory's category. Only updates if current category is 'other'
   * (auto-assigned) to avoid overriding user-explicit categorization.
   */
  async updateMemoryCategory(id: string, category: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (m:Memory {id: $id})
         WHERE m.category = 'other'
         SET m.category = $category, m.updatedAt = $now`,
        { id, category, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Update the extraction status of a Memory node.
   * Optionally increments the extractionRetries counter (for transient failure tracking).
   */
  async updateExtractionStatus(
    id: string,
    status: ExtractionStatus,
    options?: { incrementRetries?: boolean },
  ): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const retryClause = options?.incrementRetries
        ? ", m.extractionRetries = coalesce(m.extractionRetries, 0) + 1"
        : "";
      await session.run(
        `MATCH (m:Memory {id: $id})
         SET m.extractionStatus = $status, m.updatedAt = $now${retryClause}`,
        { id, status, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Get the current extraction retry count for a memory.
   */
  async getExtractionRetries(id: string): Promise<number> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (m:Memory {id: $id})
         RETURN coalesce(m.extractionRetries, 0) AS retries`,
        { id },
      );
      return (result.records[0]?.get("retries") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Batch all entity operations from an extraction result into a single managed
   * transaction. Replaces the previous pattern of N individual session-per-call
   * operations with a single atomic write.
   *
   * Operations performed atomically:
   * 1. MERGE all Entity nodes
   * 2. Create MENTIONS relationships (Memory → Entity)
   * 3. Create inter-Entity relationships (validated against allowlist)
   * 4. MERGE Tag nodes and create TAGGED relationships
   * 5. Update memory category (if classified and current is 'other')
   * 6. Set extractionStatus to 'complete'
   */
  async batchEntityOperations(
    memoryId: string,
    entities: Array<{
      id: string;
      name: string;
      type: string;
      aliases?: string[];
      description?: string;
    }>,
    relationships: Array<{
      source: string;
      target: string;
      type: string;
      confidence: number;
    }>,
    tags: Array<{ name: string; category: string }>,
    category?: string,
  ): Promise<void> {
    await this.ensureInitialized();
    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        await session.executeWrite(async (tx) => {
          const now = new Date().toISOString();

          // 1. MERGE all entities in one UNWIND
          if (entities.length > 0) {
            await tx.run(
              `UNWIND $entities AS e
               MERGE (n:Entity {name: e.name})
               ON CREATE SET
                 n.id = e.id, n.type = e.type, n.aliases = e.aliases,
                 n.description = e.description,
                 n.firstSeen = $now, n.lastSeen = $now, n.mentionCount = 1
               ON MATCH SET
                 n.type = COALESCE(e.type, n.type),
                 n.description = COALESCE(e.description, n.description),
                 n.lastSeen = $now,
                 n.mentionCount = n.mentionCount + 1`,
              {
                entities: entities.map((e) => ({
                  id: e.id,
                  name: e.name.trim().toLowerCase(),
                  type: e.type,
                  aliases: e.aliases ?? [],
                  description: e.description ?? null,
                })),
                now,
              },
            );

            // 2. Create MENTIONS relationships in one UNWIND
            await tx.run(
              `UNWIND $entityNames AS eName
               MATCH (m:Memory {id: $memoryId})
               MATCH (e:Entity {name: eName})
               MERGE (m)-[r:MENTIONS]->(e)
               ON CREATE SET r.role = 'context', r.confidence = 1.0`,
              {
                memoryId,
                entityNames: entities.map((e) => e.name.trim().toLowerCase()),
              },
            );
          }

          // 3. Create inter-Entity relationships (filter valid types)
          const validRels = relationships.filter((r) => validateRelationshipType(r.type));
          if (validRels.length > 0) {
            // Group by relationship type since Cypher requires literal rel types
            const byType = new Map<string, typeof validRels>();
            for (const rel of validRels) {
              const group = byType.get(rel.type) ?? [];
              group.push(rel);
              byType.set(rel.type, group);
            }

            for (const [relType, rels] of byType) {
              await tx.run(
                `UNWIND $rels AS r
                 MATCH (e1:Entity {name: r.source})
                 MATCH (e2:Entity {name: r.target})
                 MERGE (e1)-[rel:${relType}]->(e2)
                 ON CREATE SET rel.confidence = r.confidence, rel.createdAt = $now
                 ON MATCH SET rel.confidence = CASE WHEN r.confidence > rel.confidence THEN r.confidence ELSE rel.confidence END`,
                {
                  rels: rels.map((r) => ({
                    source: r.source.trim().toLowerCase(),
                    target: r.target.trim().toLowerCase(),
                    confidence: r.confidence,
                  })),
                  now,
                },
              );
            }
          }

          // 4. MERGE Tags and create TAGGED relationships in one UNWIND
          if (tags.length > 0) {
            await tx.run(
              `UNWIND $tags AS t
               MERGE (tag:Tag {name: t.name})
               ON CREATE SET tag.id = t.id, tag.category = t.category, tag.createdAt = $now
               WITH tag, t
               MATCH (m:Memory {id: $memoryId})
               MERGE (m)-[r:TAGGED]->(tag)
               ON CREATE SET r.confidence = 1.0`,
              {
                memoryId,
                tags: tags.map((t) => ({
                  name: t.name.trim().toLowerCase(),
                  category: t.category,
                  id: randomUUID(),
                })),
                now,
              },
            );
          }

          // 5. Update category + 6. Set extraction status (in one statement)
          const categoryClause = category
            ? ", m.category = CASE WHEN m.category = 'other' THEN $category ELSE m.category END"
            : "";
          await tx.run(
            `MATCH (m:Memory {id: $memoryId})
             SET m.extractionStatus = 'complete', m.updatedAt = $now${categoryClause}`,
            { memoryId, now, ...(category ? { category } : {}) },
          );
        });
      } finally {
        await session.close();
      }
    });
  }

  /**
   * List memories with pending extraction status.
   * Used by the sleep cycle to batch-process extractions.
   */
  async listPendingExtractions(
    limit: number = 100,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; agentId: string; extractionRetries: number }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.extractionStatus = 'pending' ${agentFilter}
         RETURN m.id AS id, m.text AS text, m.agentId AS agentId,
                coalesce(m.extractionRetries, 0) AS extractionRetries
         ORDER BY m.createdAt ASC
         LIMIT $limit`,
        { limit: neo4j.int(limit), agentId },
      );
      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        agentId: r.get("agentId") as string,
        extractionRetries: r.get("extractionRetries") as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Count memories by extraction status.
   * Used for sleep cycle progress reporting.
   */
  async countByExtractionStatus(agentId?: string): Promise<Record<ExtractionStatus, number>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         ${agentFilter}
         RETURN m.extractionStatus AS status, count(m) AS count`,
        { agentId },
      );
      const counts: Record<string, number> = {
        pending: 0,
        complete: 0,
        failed: 0,
        skipped: 0,
      };
      for (const record of result.records) {
        const status = record.get("status") as string;
        const count = (record.get("count") as { toNumber?: () => number })?.toNumber?.() ?? 0;
        if (status in counts) {
          counts[status] = count;
        }
      }
      return counts as Record<ExtractionStatus, number>;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Deduplication
  // --------------------------------------------------------------------------

  /**
   * Find clusters of near-duplicate memories by vector similarity.
   * Returns groups where each group contains memories that are duplicates of each other.
   *
   * Algorithm (O(N log N) via HNSW index, replaces O(N²) Cartesian product):
   * 1. Fetch all memory IDs and metadata
   * 2. For each memory, query the vector index for nearest neighbors above threshold
   * 3. Build clusters via union-find (transitive closure)
   * 4. Return clusters with 2+ members
   *
   * @param threshold Minimum similarity score (0-1)
   * @param agentId Optional agent filter
   * @param returnSimilarities If true, includes pairwise similarity scores in the result
   */
  async findDuplicateClusters(
    threshold: number = 0.95,
    agentId?: string,
    returnSimilarities: boolean = false,
  ): Promise<
    Array<{
      memoryIds: string[];
      texts: string[];
      importances: number[];
      similarities?: Map<string, number>;
    }>
  > {
    await this.ensureInitialized();

    // Step 1: Fetch all memory metadata in a short-lived session
    const memoryData = new Map<string, { text: string; importance: number }>();
    {
      const session = this.driver!.session();
      try {
        const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
        const allResult = await session.run(
          `MATCH (m:Memory) ${agentFilter}
           RETURN m.id AS id, m.text AS text, m.importance AS importance`,
          agentId ? { agentId } : {},
        );

        for (const r of allResult.records) {
          memoryData.set(r.get("id") as string, {
            text: r.get("text") as string,
            importance: r.get("importance") as number,
          });
        }
      } finally {
        await session.close();
      }
    }

    if (memoryData.size < 2) {
      return [];
    }

    // Step 2: For each memory, find near-duplicates via HNSW vector index
    // Each query uses a fresh short-lived session via retryOnTransient to
    // avoid a single long-lived session that could expire mid-operation.
    // Each query is O(log N) vs O(N) for brute-force, total O(N log N)
    const parent = new Map<string, string>();
    // Capture pairwise similarities if requested (for sleep cycle optimization)
    const pairwiseSimilarities = returnSimilarities ? new Map<string, number>() : null;

    const find = (x: string): string => {
      if (!parent.has(x)) {
        parent.set(x, x);
      }
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    };

    const union = (x: string, y: string): void => {
      const px = find(x);
      const py = find(y);
      if (px !== py) {
        parent.set(px, py);
      }
    };

    // Helper to create a canonical pair key (sorted)
    const makePairKey = (a: string, b: string): string => {
      return a < b ? `${a}:${b}` : `${b}:${a}`;
    };

    let pairsFound = 0;
    for (const id of memoryData.keys()) {
      // Retry individual vector queries on transient errors (each uses a fresh session)
      const similar = await this.retryOnTransient(async () => {
        const session = this.driver!.session();
        try {
          return await session.run(
            `MATCH (src:Memory {id: $id})
             CALL db.index.vector.queryNodes('memory_embedding_index', $k, src.embedding)
             YIELD node, score
             WHERE node.id <> $id AND score >= $threshold
             RETURN node.id AS matchId, score`,
            { id, k: neo4j.int(10), threshold },
          );
        } finally {
          await session.close();
        }
      });

      for (const r of similar.records) {
        const matchId = r.get("matchId") as string;
        if (memoryData.has(matchId)) {
          union(id, matchId);
          pairsFound++;

          // Capture similarity score if requested
          if (pairwiseSimilarities) {
            const score = r.get("score") as number;
            const pairKey = makePairKey(id, matchId);
            // Keep the highest score if we see this pair multiple times
            const existing = pairwiseSimilarities.get(pairKey);
            if (existing === undefined || score > existing) {
              pairwiseSimilarities.set(pairKey, score);
            }
          }
        }
      }

      // Early exit if we've found many pairs (safety bound)
      if (pairsFound > 500) {
        this.logger.warn(
          `memory-neo4j: findDuplicateClusters hit safety bound (500 pairs) — some duplicates may not be detected. Consider running with a higher threshold.`,
        );
        break;
      }
    }

    // Step 3: Group by root
    const clusters = new Map<string, string[]>();
    for (const id of memoryData.keys()) {
      if (!parent.has(id)) {
        continue;
      }
      const root = find(id);
      if (!clusters.has(root)) {
        clusters.set(root, []);
      }
      clusters.get(root)!.push(id);
    }

    // Return clusters with 2+ members
    return Array.from(clusters.values())
      .filter((ids) => ids.length >= 2)
      .map((ids) => {
        const cluster: {
          memoryIds: string[];
          texts: string[];
          importances: number[];
          similarities?: Map<string, number>;
        } = {
          memoryIds: ids,
          texts: ids.map((id) => memoryData.get(id)!.text),
          importances: ids.map((id) => memoryData.get(id)!.importance),
        };

        // Include similarities for this cluster if requested
        if (pairwiseSimilarities) {
          const clusterSims = new Map<string, number>();
          for (let i = 0; i < ids.length - 1; i++) {
            for (let j = i + 1; j < ids.length; j++) {
              const pairKey = makePairKey(ids[i], ids[j]);
              const score = pairwiseSimilarities.get(pairKey);
              if (score !== undefined) {
                clusterSims.set(pairKey, score);
              }
            }
          }
          cluster.similarities = clusterSims;
        }

        return cluster;
      });
  }

  /**
   * Merge duplicate memories by keeping the one with highest importance
   * and deleting the rest. Transfers MENTIONS relationships to the survivor.
   */
  async mergeMemoryCluster(
    memoryIds: string[],
    importances: number[],
  ): Promise<{ survivorId: string; deletedCount: number }> {
    await this.ensureInitialized();

    // Find the survivor (highest importance)
    let survivorIdx = 0;
    for (let i = 1; i < importances.length; i++) {
      if (importances[i] > importances[survivorIdx]) {
        survivorIdx = i;
      }
    }
    const survivorId = memoryIds[survivorIdx];
    const toDelete = memoryIds.filter((_, i) => i !== survivorIdx);

    return this.retryOnTransient(async () => {
      const session = this.driver!.session();
      try {
        // Execute verify + transfer + delete in a single write transaction
        // to prevent TOCTOU races (member deleted between verify and merge)
        const deletedCount = await session.executeWrite(async (tx) => {
          // Verify all cluster members still exist
          const verifyResult = await tx.run(
            `UNWIND $ids AS memId
             OPTIONAL MATCH (m:Memory {id: memId})
             RETURN memId, m IS NOT NULL AS exists`,
            { ids: memoryIds },
          );

          const missingIds: string[] = [];
          for (const r of verifyResult.records) {
            if (!r.get("exists")) {
              missingIds.push(r.get("memId") as string);
            }
          }

          if (missingIds.length > 0) {
            this.logger.warn(
              `memory-neo4j: skipping cluster merge — ${missingIds.length} member(s) no longer exist: ${missingIds.join(", ")}`,
            );
            return 0;
          }

          // Transfer MENTIONS relationships from deleted memories to survivor
          await tx.run(
            `UNWIND $toDelete AS deadId
             MATCH (dead:Memory {id: deadId})-[r:MENTIONS]->(e:Entity)
             MATCH (survivor:Memory {id: $survivorId})
             MERGE (survivor)-[:MENTIONS]->(e)
             DELETE r`,
            { toDelete, survivorId },
          );

          // Delete the duplicate memories
          await tx.run(
            `UNWIND $toDelete AS deadId
             MATCH (m:Memory {id: deadId})
             DETACH DELETE m`,
            { toDelete },
          );

          return toDelete.length;
        });

        return { survivorId, deletedCount };
      } finally {
        await session.close();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Decay & Pruning
  // --------------------------------------------------------------------------

  /**
   * Find memories that have decayed below the retention threshold.
   *
   * Decay formula (Ebbinghaus-inspired):
   *   decay_score = importance × e^(-age_days / half_life)
   *
   * Where half_life scales with importance:
   *   half_life = baseHalfLifeDays × (1 + importance × importanceMultiplier)
   *
   * A memory with importance=1.0 decays slower than one with importance=0.3.
   *
   * IMPORTANT: Core memories (category='core') are EXEMPT from decay.
   * They persist indefinitely regardless of age.
   */
  async findDecayedMemories(
    options: {
      retentionThreshold?: number; // Below this score, memory is pruned (default: 0.1)
      baseHalfLifeDays?: number; // Base half-life for decay (default: 30)
      importanceMultiplier?: number; // How much importance extends half-life (default: 2)
      agentId?: string;
      limit?: number;
    } = {},
  ): Promise<
    Array<{ id: string; text: string; importance: number; ageDays: number; decayScore: number }>
  > {
    const {
      retentionThreshold = 0.1,
      baseHalfLifeDays = 30,
      importanceMultiplier = 2,
      agentId,
      limit = 500,
    } = options;

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.createdAt IS NOT NULL
           AND m.category <> 'core'
           ${agentFilter}
         WITH m,
              duration.between(datetime(m.createdAt), datetime()).days AS ageDays,
              m.importance AS importance
         WITH m, ageDays, importance,
              $baseHalfLife * (1.0 + importance * $importanceMult) AS halfLife
         WITH m, ageDays, importance, halfLife,
              importance * exp(-1.0 * ageDays / halfLife) AS decayScore
         WHERE decayScore < $threshold
         RETURN m.id AS id, m.text AS text, importance, ageDays, decayScore
         ORDER BY decayScore ASC
         LIMIT $limit`,
        {
          threshold: retentionThreshold,
          baseHalfLife: baseHalfLifeDays,
          importanceMult: importanceMultiplier,
          agentId,
          limit: neo4j.int(limit),
        },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        importance: r.get("importance") as number,
        ageDays: r.get("ageDays") as number,
        decayScore: r.get("decayScore") as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete decayed memories and decrement entity mention counts.
   */
  async pruneMemories(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      // Atomic: decrement mentionCount and delete in a single Cypher statement
      // to prevent inconsistent state if a crash occurs between operations
      const result = await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})
         OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
         SET e.mentionCount = CASE WHEN e.mentionCount > 0 THEN e.mentionCount - 1 ELSE 0 END
         WITH m, count(e) AS _
         DETACH DELETE m
         RETURN count(*) AS deleted`,
        { ids: memoryIds },
      );

      return (result.records[0]?.get("deleted") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Orphan Cleanup
  // --------------------------------------------------------------------------

  /**
   * Find orphaned Entity nodes (no MENTIONS relationships from any Memory).
   */
  async findOrphanEntities(
    limit: number = 500,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (e:Entity)
         WHERE coalesce(e.mentionCount, 0) <= 0
         RETURN e.id AS id, e.name AS name, e.type AS type
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
        type: r.get("type") as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete orphaned entities and their relationships.
   */
  async deleteOrphanEntities(entityIds: string[]): Promise<number> {
    if (entityIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS entId
         MATCH (e:Entity {id: entId})
         DETACH DELETE e
         RETURN count(*) AS deleted`,
        { ids: entityIds },
      );

      return (result.records[0]?.get("deleted") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Find orphaned Tag nodes (no TAGGED relationships from any Memory).
   */
  async findOrphanTags(limit: number = 500): Promise<Array<{ id: string; name: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (t:Tag)
         WHERE NOT EXISTS { MATCH (:Memory)-[:TAGGED]->(t) }
         RETURN t.id AS id, t.name AS name
         LIMIT $limit`,
        { limit: neo4j.int(limit) },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete orphaned tags.
   */
  async deleteOrphanTags(tagIds: string[]): Promise<number> {
    if (tagIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS tagId
         MATCH (t:Tag {id: tagId})
         DETACH DELETE t
         RETURN count(*) AS deleted`,
        { ids: tagIds },
      );

      return (result.records[0]?.get("deleted") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Conflict Detection
  // --------------------------------------------------------------------------

  /**
   * Find memory pairs that share at least one entity (via MENTIONS relationships).
   * These are candidates for conflict resolution — the LLM decides if they truly conflict.
   * Excludes core memories (conflicts there are handled by promotion/demotion).
   */
  async findConflictingMemories(agentId?: string): Promise<
    Array<{
      memoryA: { id: string; text: string; importance: number; createdAt: string };
      memoryB: { id: string; text: string; importance: number; createdAt: string };
    }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m1.agentId = $agentId AND m2.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m1:Memory)-[:MENTIONS]->(e:Entity)<-[:MENTIONS]-(m2:Memory)
         WHERE m1.id < m2.id ${agentFilter}
         AND m1.category <> 'core' AND m2.category <> 'core'
         WITH m1, m2, count(e) AS sharedEntities
         WHERE sharedEntities >= 1
         RETURN DISTINCT m1.id AS m1Id, m1.text AS m1Text, m1.importance AS m1Importance, m1.createdAt AS m1CreatedAt,
                m2.id AS m2Id, m2.text AS m2Text, m2.importance AS m2Importance, m2.createdAt AS m2CreatedAt
         LIMIT 50`,
        agentId ? { agentId } : {},
      );

      return result.records.map((r) => ({
        memoryA: {
          id: r.get("m1Id"),
          text: r.get("m1Text"),
          importance: r.get("m1Importance"),
          createdAt: String(r.get("m1CreatedAt") ?? ""),
        },
        memoryB: {
          id: r.get("m2Id"),
          text: r.get("m2Text"),
          importance: r.get("m2Importance"),
          createdAt: String(r.get("m2CreatedAt") ?? ""),
        },
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Invalidate a memory by setting its importance to near-zero.
   * Used by conflict resolution to effectively retire the losing memory
   * without deleting it (it will be pruned naturally by the decay phase).
   */
  async invalidateMemory(id: string): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (m:Memory {id: $id})
         SET m.importance = 0.01, m.updatedAt = $now`,
        { id, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Sleep Cycle: Core Memory Promotion
  // --------------------------------------------------------------------------

  /**
   * Calculate effective scores for all memories to determine Pareto threshold.
   *
   * Uses: importance × freq_boost × recency for ALL memories (including core).
   * This gives core memories a slight disadvantage (they need strong retrieval
   * patterns to stay in top 20%), creating healthy churn.
   */
  async calculateAllEffectiveScores(agentId?: string): Promise<
    Array<{
      id: string;
      text: string;
      category: string;
      importance: number;
      retrievalCount: number;
      ageDays: number;
      effectiveScore: number;
    }>
  > {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId
        ? "WHERE m.agentId = $agentId AND m.createdAt IS NOT NULL"
        : "WHERE m.createdAt IS NOT NULL";
      const result = await session.run(
        `MATCH (m:Memory)
         ${agentFilter}
         WITH m,
              coalesce(m.retrievalCount, 0) AS retrievalCount,
              duration.between(datetime(m.createdAt), datetime()).days AS ageDays,
              CASE
                WHEN m.lastRetrievedAt IS NULL THEN null
                ELSE duration.between(datetime(m.lastRetrievedAt), datetime()).days
              END AS daysSinceRetrieval
         WITH m, retrievalCount, ageDays, daysSinceRetrieval,
              // Effective score: importance × freq_boost × recency
              // This is used for global ranking (promotion/demotion threshold)
              m.importance * (1 + log(1 + retrievalCount) * 0.3) *
                CASE
                  WHEN daysSinceRetrieval IS NULL THEN 0.1
                  ELSE 2.0 ^ (-1.0 * daysSinceRetrieval / 14.0)
                END AS effectiveScore
         RETURN m.id AS id, m.text AS text, m.category AS category,
                m.importance AS importance, retrievalCount, ageDays, effectiveScore
         ORDER BY effectiveScore DESC`,
        agentId ? { agentId } : {},
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        category: r.get("category") as string,
        importance: r.get("importance") as number,
        retrievalCount: r.get("retrievalCount") as number,
        ageDays: r.get("ageDays") as number,
        effectiveScore: r.get("effectiveScore") as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate the Pareto threshold (80th percentile) for promotion/demotion.
   * Returns the effective score that separates top 20% from bottom 80%.
   */
  calculateParetoThreshold(
    scores: Array<{ effectiveScore: number }>,
    percentile: number = 0.8,
  ): number {
    if (scores.length === 0) {
      return 0;
    }

    // Scores should already be sorted descending, but ensure it
    const sorted = scores.toSorted((a, b) => b.effectiveScore - a.effectiveScore);

    // Find the index at the percentile boundary
    // For top 20%, we want the score at index = 20% of total
    const topPercent = 1 - percentile; // 0.2 for top 20%
    const boundaryIndex = Math.floor(sorted.length * topPercent);

    // Return the score at that boundary (or 0 if empty)
    return sorted[boundaryIndex]?.effectiveScore ?? 0;
  }

  /**
   * Promote memories to core status.
   */
  async promoteToCore(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})
         SET m.category = 'core', m.promotedAt = $now, m.updatedAt = $now
         RETURN count(*) AS promoted`,
        { ids: memoryIds, now: new Date().toISOString() },
      );

      return (result.records[0]?.get("promoted") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Demote memories from core back to their original category.
   * Uses 'fact' as default since we don't track original category.
   */
  async demoteFromCore(memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) {
      return 0;
    }

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})
         WHERE m.category = 'core'
         SET m.category = 'fact', m.demotedAt = $now, m.updatedAt = $now
         RETURN count(*) AS demoted`,
        { ids: memoryIds, now: new Date().toISOString() },
      );

      return (result.records[0]?.get("demoted") as number) ?? 0;
    } finally {
      await session.close();
    }
  }

  // --------------------------------------------------------------------------
  // Reindex: re-embed all Memory and Entity nodes
  // --------------------------------------------------------------------------

  /**
   * Re-embed all Memory nodes with a new embedding model.
   *
   * Steps:
   * 1. Drop old vector index (dimensions may have changed)
   * 2. Fetch all Memory nodes and re-embed their text
   * 3. Recreate vector index with current dimensions
   *
   * Entities and tags are not affected — they use fulltext search
   * and graph traversal, not vector embeddings.
   *
   * Used after changing the embedding model/provider in config.
   */
  async reindex(
    embedFn: (texts: string[]) => Promise<number[][]>,
    options?: {
      batchSize?: number;
      onProgress?: (phase: string, done: number, total: number) => void;
    },
  ): Promise<{ memories: number }> {
    const batchSize = options?.batchSize ?? 50;
    const progress = options?.onProgress ?? (() => {});

    await this.ensureInitialized();

    // Step 1: Drop old vector index
    progress("drop-indexes", 0, 1);
    const dropSession = this.driver!.session();
    try {
      await this.runSafe(dropSession, "DROP INDEX memory_embedding_index IF EXISTS");
    } finally {
      await dropSession.close();
    }
    progress("drop-indexes", 1, 1);

    // Step 2: Fetch and re-embed memories
    const fetchSession = this.driver!.session();
    let memories: Array<{ id: string; text: string }>;
    try {
      const result = await fetchSession.run(
        "MATCH (m:Memory) RETURN m.id AS id, m.text AS text ORDER BY m.createdAt ASC",
      );
      memories = result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
      }));
    } finally {
      await fetchSession.close();
    }
    progress("memories", 0, memories.length);

    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      const vectors = await embedFn(batch.map((m) => m.text));

      const session = this.driver!.session();
      try {
        for (let j = 0; j < batch.length; j++) {
          if (vectors[j] && vectors[j].length > 0) {
            await session.run("MATCH (m:Memory {id: $id}) SET m.embedding = $embedding", {
              id: batch[j].id,
              embedding: vectors[j],
            });
          }
        }
      } finally {
        await session.close();
      }
      progress("memories", Math.min(i + batchSize, memories.length), memories.length);
    }

    // Step 3: Recreate vector index with current dimensions
    progress("create-indexes", 0, 1);
    const indexSession = this.driver!.session();
    try {
      await this.runSafe(
        indexSession,
        `CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
         FOR (m:Memory) ON m.embedding
         OPTIONS {indexConfig: {
           \`vector.dimensions\`: ${this.dimensions},
           \`vector.similarity_function\`: 'cosine'
         }}`,
      );
    } finally {
      await indexSession.close();
    }
    progress("create-indexes", 1, 1);

    return { memories: memories.length };
  }

  // --------------------------------------------------------------------------
  // Retry Logic
  // --------------------------------------------------------------------------

  /**
   * Retry an operation on transient Neo4j errors (deadlocks, connection blips, etc.)
   * with exponential backoff. Adapted from ontology project.
   */
  private async retryOnTransient<T>(
    fn: () => Promise<T>,
    maxAttempts: number = TRANSIENT_RETRY_ATTEMPTS,
    baseDelay: number = TRANSIENT_RETRY_BASE_DELAY_MS,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        // Check for Neo4j transient errors (deadlocks, connection blips, service unavailable)
        const errCode =
          err instanceof Error
            ? ((err as unknown as Record<string, unknown>).code as string | undefined)
            : undefined;
        const isTransient =
          err instanceof Error &&
          (err.message.includes("DeadlockDetected") ||
            err.message.includes("TransientError") ||
            err.message.includes("ServiceUnavailable") ||
            err.message.includes("SessionExpired") ||
            err.message.includes("ConnectionRefused") ||
            err.message.includes("connection terminated") ||
            (err.constructor.name === "Neo4jError" &&
              typeof errCode === "string" &&
              (errCode.startsWith("Neo.TransientError.") ||
                errCode === "ServiceUnavailable" ||
                errCode === "SessionExpired")));

        if (!isTransient || attempt >= maxAttempts - 1) {
          throw err;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        this.logger.warn(
          `memory-neo4j: transient error, retrying (${attempt + 1}/${maxAttempts}): ${String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }
}
