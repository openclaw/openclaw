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
          createdAt: $createdAt, updatedAt: $updatedAt
        })
        RETURN m.id AS id`,
        {
          ...input,
          sessionKey: input.sessionKey ?? null,
          createdAt: now,
          updatedAt: now,
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
        { embedding, limit, minScore, ...(agentId ? { agentId } : {}) },
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
        { query: escaped, limit, ...(agentId ? { agentId } : {}) },
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
        { embedding, limit, threshold },
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
