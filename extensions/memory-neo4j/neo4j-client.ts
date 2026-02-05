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
import { escapeLucene, validateRelationshipType } from "./schema.js";

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
    this.initPromise = this.doInitialize();
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
      await this.runSafe(
        session,
        `
        CREATE VECTOR INDEX entity_embedding_index IF NOT EXISTS
        FOR (e:Entity) ON e.embedding
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
          retrievalCount: $retrievalCount, lastRetrievedAt: $lastRetrievedAt
        })
        RETURN m.id AS id`,
        {
          ...input,
          sessionKey: input.sessionKey ?? null,
          createdAt: now,
          updatedAt: now,
          retrievalCount: 0,
          lastRetrievedAt: null,
        },
      );
      return result.records[0].get("id") as string;
    } finally {
      await session.close();
    }
  }

  async deleteMemory(id: string): Promise<boolean> {
    await this.ensureInitialized();
    // Validate UUID format to prevent injection
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    const session = this.driver!.session();
    try {
      // First, decrement mentionCount on connected entities
      await session.run(
        `MATCH (m:Memory {id: $id})-[:MENTIONS]->(e:Entity)
         SET e.mentionCount = e.mentionCount - 1`,
        { id },
      );

      // Then delete the memory with all its relationships
      const result = await session.run(
        `MATCH (m:Memory {id: $id})
         DETACH DELETE m
         RETURN count(*) AS deleted`,
        { id },
      );

      const deleted =
        result.records.length > 0 ? (result.records[0].get("deleted") as number) > 0 : false;
      return deleted;
    } finally {
      await session.close();
    }
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
    } catch (err) {
      // Graceful degradation: return empty if vector index isn't ready
      this.logger.warn(`memory-neo4j: vector search failed: ${String(err)}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Signal 2: Lucene BM25 full-text keyword search.
   * Returns memories ranked by BM25 relevance score.
   */
  async bm25Search(query: string, limit: number, agentId?: string): Promise<SearchSignalResult[]> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const escaped = escapeLucene(query);
      if (!escaped.trim()) {
        return [];
      }

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
        { query: escaped, limit: neo4j.int(Math.floor(limit)), ...(agentId ? { agentId } : {}) },
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
    } catch (err) {
      this.logger.warn(`memory-neo4j: BM25 search failed: ${String(err)}`);
      return [];
    } finally {
      await session.close();
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
    const session = this.driver!.session();
    try {
      const escaped = escapeLucene(query);
      if (!escaped.trim()) {
        return [];
      }

      // Step 1: Find matching entities
      const entityResult = await session.run(
        `CALL db.index.fulltext.queryNodes('entity_fulltext_index', $query)
         YIELD node, score
         WHERE score >= 0.5
         RETURN node.id AS entityId, node.name AS name, score
         ORDER BY score DESC
         LIMIT 5`,
        { query: escaped },
      );

      const entityIds = entityResult.records.map((r) => r.get("entityId") as string);
      if (entityIds.length === 0) {
        return [];
      }

      // Step 2 + 3: Direct mentions + 1-hop spreading activation
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `UNWIND $entityIds AS eid
         // Direct: Entity ← MENTIONS ← Memory
         OPTIONAL MATCH (e:Entity {id: eid})<-[rm:MENTIONS]-(m:Memory)
         WHERE m IS NOT NULL ${agentFilter}
         WITH m, coalesce(rm.confidence, 1.0) AS directScore
         WHERE m IS NOT NULL

         RETURN m.id AS id, m.text AS text, m.category AS category,
                m.importance AS importance, m.createdAt AS createdAt,
                max(directScore) AS graphScore

         UNION

         UNWIND $entityIds AS eid
         // 1-hop: Entity → relationship → Entity ← MENTIONS ← Memory
         OPTIONAL MATCH (e:Entity {id: eid})-[r1:RELATED_TO|KNOWS|WORKS_AT|LIVES_AT|MARRIED_TO|PREFERS|DECIDED]-(e2:Entity)
         WHERE coalesce(r1.confidence, 0.7) >= $firingThreshold
         OPTIONAL MATCH (e2)<-[rm:MENTIONS]-(m:Memory)
         WHERE m IS NOT NULL ${agentFilter}
         WITH m, coalesce(r1.confidence, 0.7) * coalesce(rm.confidence, 1.0) AS hopScore
         WHERE m IS NOT NULL

         RETURN m.id AS id, m.text AS text, m.category AS category,
                m.importance AS importance, m.createdAt AS createdAt,
                max(hopScore) AS graphScore`,
        { entityIds, firingThreshold, ...(agentId ? { agentId } : {}) },
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
    } catch (err) {
      this.logger.warn(`memory-neo4j: graph search failed: ${String(err)}`);
      return [];
    } finally {
      await session.close();
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
    } catch (err) {
      // If vector index isn't ready, return no duplicates (allow store)
      this.logger.debug?.(`memory-neo4j: similarity check failed: ${String(err)}`);
      return [];
    } finally {
      await session.close();
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
  }

  /**
   * Calculate effective importance using retrieval-based reinforcement.
   *
   * Two modes:
   * 1. With importance (regular memories): importance × freq_boost × recency
   * 2. Without importance (core memories): freq_boost × recency
   *
   * Research basis:
   * - ACT-R memory model (frequency with power-law decay)
   * - FSRS spaced repetition (stability/retrievability)
   * - Ebbinghaus forgetting curve (exponential decay)
   */
  calculateEffectiveImportance(
    retrievalCount: number,
    daysSinceLastRetrieval: number | null,
    options: {
      baseImportance?: number; // Include importance multiplier (for regular memories)
      frequencyScale?: number; // How much retrievals boost importance (default: 0.3)
      recencyHalfLifeDays?: number; // Half-life for recency decay (default: 14)
    } = {},
  ): number {
    const { baseImportance, frequencyScale = 0.3, recencyHalfLifeDays = 14 } = options;

    // Frequency boost: log(1 + n) provides diminishing returns
    // log(1+0)=0, log(1+1)≈0.69, log(1+10)≈2.4, log(1+100)≈4.6
    const frequencyBoost = 1 + Math.log1p(retrievalCount) * frequencyScale;

    // Recency factor: exponential decay with configurable half-life
    // If never retrieved (null), use a baseline factor
    let recencyFactor: number;
    if (daysSinceLastRetrieval === null) {
      recencyFactor = 0.1; // Never retrieved - low baseline
    } else {
      recencyFactor = Math.pow(2, -daysSinceLastRetrieval / recencyHalfLifeDays);
    }

    // Combined effective importance
    const usageScore = frequencyBoost * recencyFactor;

    // Include importance multiplier if provided (for regular memories)
    if (baseImportance !== undefined) {
      return baseImportance * usageScore;
    }

    // Pure usage-based (for core memories)
    return usageScore;
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
             e.description = $description, e.embedding = $embedding,
             e.firstSeen = $now, e.lastSeen = $now, e.mentionCount = 1
           ON MATCH SET
             e.type = COALESCE($type, e.type),
             e.description = COALESCE($description, e.description),
             e.embedding = COALESCE($embedding, e.embedding),
             e.lastSeen = $now,
             e.mentionCount = e.mentionCount + 1
           RETURN e.id AS id, e.name AS name`,
          {
            id: input.id,
            name: input.name.trim().toLowerCase(),
            type: input.type,
            aliases: input.aliases ?? [],
            description: input.description ?? null,
            embedding: input.embedding ?? null,
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
   */
  async updateExtractionStatus(id: string, status: ExtractionStatus): Promise<void> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (m:Memory {id: $id})
         SET m.extractionStatus = $status, m.updatedAt = $now`,
        { id, status, now: new Date().toISOString() },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * List memories with pending extraction status.
   * Used by the sleep cycle to batch-process extractions.
   */
  async listPendingExtractions(
    limit: number = 100,
    agentId?: string,
  ): Promise<Array<{ id: string; text: string; agentId: string }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.extractionStatus = 'pending' ${agentFilter}
         RETURN m.id AS id, m.text AS text, m.agentId AS agentId
         ORDER BY m.createdAt ASC
         LIMIT $limit`,
        { limit: neo4j.int(limit), agentId },
      );
      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        agentId: r.get("agentId") as string,
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
   */
  async findDuplicateClusters(
    threshold: number = 0.95,
    agentId?: string,
  ): Promise<Array<{ memoryIds: string[]; texts: string[]; importances: number[] }>> {
    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      // Step 1: Fetch all memory metadata (no embeddings — lightweight)
      const agentFilter = agentId ? "WHERE m.agentId = $agentId" : "";
      const allResult = await session.run(
        `MATCH (m:Memory) ${agentFilter}
         RETURN m.id AS id, m.text AS text, m.importance AS importance`,
        agentId ? { agentId } : {},
      );

      const memoryData = new Map<string, { text: string; importance: number }>();
      for (const r of allResult.records) {
        memoryData.set(r.get("id") as string, {
          text: r.get("text") as string,
          importance: r.get("importance") as number,
        });
      }

      if (memoryData.size < 2) {
        return [];
      }

      // Step 2: For each memory, find near-duplicates via HNSW vector index
      // Each query is O(log N) vs O(N) for brute-force, total O(N log N)
      const parent = new Map<string, string>();

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

      let pairsFound = 0;
      for (const id of memoryData.keys()) {
        const similar = await session.run(
          `MATCH (src:Memory {id: $id})
           CALL db.index.vector.queryNodes('memory_embedding_index', $k, src.embedding)
           YIELD node, score
           WHERE node.id <> $id AND score >= $threshold
           RETURN node.id AS matchId`,
          { id, k: neo4j.int(10), threshold },
        );

        for (const r of similar.records) {
          const matchId = r.get("matchId") as string;
          if (memoryData.has(matchId)) {
            union(id, matchId);
            pairsFound++;
          }
        }

        // Early exit if we've found many pairs (safety bound)
        if (pairsFound > 500) {
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
        .map((ids) => ({
          memoryIds: ids,
          texts: ids.map((id) => memoryData.get(id)!.text),
          importances: ids.map((id) => memoryData.get(id)!.importance),
        }));
    } finally {
      await session.close();
    }
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

    const session = this.driver!.session();
    try {
      // Transfer MENTIONS relationships from deleted memories to survivor
      await session.run(
        `UNWIND $toDelete AS deadId
         MATCH (dead:Memory {id: deadId})-[r:MENTIONS]->(e:Entity)
         MATCH (survivor:Memory {id: $survivorId})
         MERGE (survivor)-[:MENTIONS]->(e)
         DELETE r`,
        { toDelete, survivorId },
      );

      // Delete the duplicate memories
      await session.run(
        `UNWIND $toDelete AS deadId
         MATCH (m:Memory {id: deadId})
         DETACH DELETE m`,
        { toDelete },
      );

      return { survivorId, deletedCount: toDelete.length };
    } finally {
      await session.close();
    }
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
      // Decrement mention counts on connected entities
      await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})-[:MENTIONS]->(e:Entity)
         SET e.mentionCount = e.mentionCount - 1`,
        { ids: memoryIds },
      );

      // Delete the memories
      const result = await session.run(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})
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
   * Find regular memories that should be promoted to core (above Pareto threshold).
   *
   * Pareto-based promotion:
   * - Calculate effective score for all memories: importance × freq × recency
   * - Find the 80th percentile threshold (top 20%)
   * - Regular memories above threshold get promoted to core
   * - Also requires minimum age (default: 7 days) to ensure stability
   */
  async findPromotionCandidates(options: {
    paretoThreshold: number; // The calculated Pareto threshold
    minAgeDays?: number; // Minimum age in days (default: 7)
    agentId?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      text: string;
      category: string;
      importance: number;
      ageDays: number;
      retrievalCount: number;
      effectiveScore: number;
    }>
  > {
    const { paretoThreshold, minAgeDays = 7, agentId, limit = 100 } = options;

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.category <> 'core'
           AND m.createdAt IS NOT NULL
           ${agentFilter}
         WITH m,
              duration.between(datetime(m.createdAt), datetime()).days AS ageDays,
              coalesce(m.retrievalCount, 0) AS retrievalCount,
              CASE
                WHEN m.lastRetrievedAt IS NULL THEN null
                ELSE duration.between(datetime(m.lastRetrievedAt), datetime()).days
              END AS daysSinceRetrieval
         WHERE ageDays >= $minAgeDays
         WITH m, ageDays, retrievalCount, daysSinceRetrieval,
              // Effective score: importance × freq_boost × recency
              m.importance * (1 + log(1 + retrievalCount) * 0.3) *
                CASE
                  WHEN daysSinceRetrieval IS NULL THEN 0.1
                  ELSE 2.0 ^ (-1.0 * daysSinceRetrieval / 14.0)
                END AS effectiveScore
         WHERE effectiveScore >= $threshold
         RETURN m.id AS id, m.text AS text, m.category AS category,
                m.importance AS importance, ageDays, retrievalCount, effectiveScore
         ORDER BY effectiveScore DESC
         LIMIT $limit`,
        {
          threshold: paretoThreshold,
          minAgeDays,
          agentId,
          limit: neo4j.int(limit),
        },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        category: r.get("category") as string,
        importance: r.get("importance") as number,
        ageDays: r.get("ageDays") as number,
        retrievalCount: r.get("retrievalCount") as number,
        effectiveScore: r.get("effectiveScore") as number,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Find core memories that should be demoted (fallen below Pareto threshold).
   *
   * Core memories use the same formula for threshold comparison:
   * importance × freq × recency
   *
   * If they fall below the top 20% threshold, they get demoted back to regular.
   */
  async findDemotionCandidates(options: {
    paretoThreshold: number; // The calculated Pareto threshold
    agentId?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      text: string;
      importance: number;
      retrievalCount: number;
      effectiveScore: number;
    }>
  > {
    const { paretoThreshold, agentId, limit = 100 } = options;

    await this.ensureInitialized();
    const session = this.driver!.session();
    try {
      const agentFilter = agentId ? "AND m.agentId = $agentId" : "";
      const result = await session.run(
        `MATCH (m:Memory)
         WHERE m.category = 'core'
           ${agentFilter}
         WITH m,
              coalesce(m.retrievalCount, 0) AS retrievalCount,
              CASE
                WHEN m.lastRetrievedAt IS NULL THEN null
                ELSE duration.between(datetime(m.lastRetrievedAt), datetime()).days
              END AS daysSinceRetrieval
         WITH m, retrievalCount, daysSinceRetrieval,
              // Effective score: importance × freq_boost × recency
              m.importance * (1 + log(1 + retrievalCount) * 0.3) *
                CASE
                  WHEN daysSinceRetrieval IS NULL THEN 0.1
                  ELSE 2.0 ^ (-1.0 * daysSinceRetrieval / 14.0)
                END AS effectiveScore
         WHERE effectiveScore < $threshold
         RETURN m.id AS id, m.text AS text, m.importance AS importance,
                retrievalCount, effectiveScore
         ORDER BY effectiveScore ASC
         LIMIT $limit`,
        {
          threshold: paretoThreshold,
          agentId,
          limit: neo4j.int(limit),
        },
      );

      return result.records.map((r) => ({
        id: r.get("id") as string,
        text: r.get("text") as string,
        importance: r.get("importance") as number,
        retrievalCount: r.get("retrievalCount") as number,
        effectiveScore: r.get("effectiveScore") as number,
      }));
    } finally {
      await session.close();
    }
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
  // Retry Logic
  // --------------------------------------------------------------------------

  /**
   * Retry an operation on transient Neo4j errors (deadlocks, etc.)
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
        // Check for Neo4j transient errors
        const isTransient =
          err instanceof Error &&
          (err.message.includes("DeadlockDetected") ||
            err.message.includes("TransientError") ||
            (err.constructor.name === "Neo4jError" &&
              (err as unknown as Record<string, unknown>).code ===
                "Neo.TransientError.Transaction.DeadlockDetected"));

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
