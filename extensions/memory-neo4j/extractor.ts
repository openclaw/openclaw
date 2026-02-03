/**
 * LLM-based entity extraction and auto-capture decision for memory-neo4j.
 *
 * Uses Gemini Flash via OpenRouter for:
 * 1. Entity extraction: Extract entities and relationships from stored memories
 * 2. Auto-capture decision: Decide what's worth remembering from conversations
 *
 * Both run as background fire-and-forget operations with graceful degradation.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { CaptureItem, EntityType, ExtractionResult, MemoryCategory } from "./schema.js";
import { ALLOWED_RELATIONSHIP_TYPES, ENTITY_TYPES } from "./schema.js";

// ============================================================================
// Types
// ============================================================================

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

// ============================================================================
// Extraction Prompt
// ============================================================================

const ENTITY_EXTRACTION_PROMPT = `You are an entity extraction system for a personal memory store.
Extract entities and relationships from this memory text.

Memory: "{text}"

Return JSON:
{
  "entities": [
    {"name": "tarun", "type": "person", "aliases": ["boss"], "description": "brief description"}
  ],
  "relationships": [
    {"source": "tarun", "target": "abundent", "type": "WORKS_AT", "confidence": 0.95}
  ],
  "tags": [
    {"name": "neo4j", "category": "technology"}
  ]
}

Rules:
- Normalize entity names to lowercase
- Entity types: person, organization, location, event, concept
- Relationship types: WORKS_AT, LIVES_AT, KNOWS, MARRIED_TO, PREFERS, DECIDED, RELATED_TO
- Confidence: 0.0-1.0
- Only extract what's explicitly stated or strongly implied
- Return empty arrays if nothing to extract
- Keep entity descriptions brief (1 sentence max)`;

// ============================================================================
// Auto-Capture Decision Prompt
// ============================================================================

const AUTO_CAPTURE_PROMPT = `You are an AI memory curator. Given these user messages from a conversation, identify information worth storing as long-term memories.

Only extract:
- Personal preferences and opinions ("I prefer dark mode", "I like TypeScript")
- Important facts about people, places, organizations
- Decisions made ("We decided to use Neo4j", "Going with plan A")
- Contact information (emails, phone numbers, usernames)
- Important events or dates
- Technical decisions and configurations

Do NOT extract:
- General questions or instructions to the AI
- Routine greetings or acknowledgments
- Information that is too vague or contextual
- Information already in system prompts or documentation

Messages:
"""
{messages}
"""

Return JSON:
{
  "memories": [
    {"text": "concise memory text", "category": "preference|fact|decision|entity|other", "importance": 0.7}
  ]
}

If nothing is worth remembering, return: {"memories": []}`;

// ============================================================================
// OpenRouter API Client
// ============================================================================

async function callOpenRouter(config: ExtractionConfig, prompt: string): Promise<string | null> {
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: config.temperature,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      if (attempt >= config.maxRetries) {
        throw err;
      }
      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

// ============================================================================
// Entity Extraction
// ============================================================================

/**
 * Extract entities and relationships from a memory text using LLM.
 */
export async function extractEntities(
  text: string,
  config: ExtractionConfig,
): Promise<ExtractionResult | null> {
  if (!config.enabled) {
    return null;
  }

  const prompt = ENTITY_EXTRACTION_PROMPT.replace("{text}", text);

  try {
    const content = await callOpenRouter(config, prompt);
    if (!content) {
      return null;
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    return validateExtractionResult(parsed);
  } catch {
    // Will be handled by caller; don't throw for parse errors
    return null;
  }
}

/**
 * Validate and sanitize LLM extraction output.
 */
function validateExtractionResult(raw: Record<string, unknown>): ExtractionResult {
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  const validEntityTypes = new Set<string>(ENTITY_TYPES);

  return {
    entities: entities
      .filter(
        (e: unknown): e is Record<string, unknown> =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as Record<string, unknown>).name === "string" &&
          typeof (e as Record<string, unknown>).type === "string",
      )
      .map((e) => ({
        name: String(e.name).trim().toLowerCase(),
        type: validEntityTypes.has(String(e.type)) ? (String(e.type) as EntityType) : "concept",
        aliases: Array.isArray(e.aliases)
          ? (e.aliases as unknown[])
              .filter((a): a is string => typeof a === "string")
              .map((a) => a.trim().toLowerCase())
          : undefined,
        description: typeof e.description === "string" ? e.description : undefined,
      }))
      .filter((e) => e.name.length > 0),

    relationships: relationships
      .filter(
        (r: unknown): r is Record<string, unknown> =>
          r !== null &&
          typeof r === "object" &&
          typeof (r as Record<string, unknown>).source === "string" &&
          typeof (r as Record<string, unknown>).target === "string" &&
          typeof (r as Record<string, unknown>).type === "string" &&
          ALLOWED_RELATIONSHIP_TYPES.has(String((r as Record<string, unknown>).type)),
      )
      .map((r) => ({
        source: String(r.source).trim().toLowerCase(),
        target: String(r.target).trim().toLowerCase(),
        type: String(r.type),
        confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.7,
      })),

    tags: tags
      .filter(
        (t: unknown): t is Record<string, unknown> =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).name === "string",
      )
      .map((t) => ({
        name: String(t.name).trim().toLowerCase(),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0),
  };
}

// ============================================================================
// Background Extraction Pipeline
// ============================================================================

/**
 * Run entity extraction in the background for a stored memory.
 * Fire-and-forget: errors are logged but never propagated.
 *
 * Flow:
 * 1. Call LLM to extract entities and relationships
 * 2. MERGE Entity nodes (idempotent)
 * 3. Create MENTIONS relationships from Memory → Entity
 * 4. Create inter-Entity relationships (WORKS_AT, KNOWS, etc.)
 * 5. Tag the memory
 * 6. Update extractionStatus to "complete" or "failed"
 */
export async function runBackgroundExtraction(
  memoryId: string,
  text: string,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
): Promise<void> {
  if (!config.enabled) {
    await db.updateExtractionStatus(memoryId, "skipped").catch(() => {});
    return;
  }

  try {
    const result = await extractEntities(text, config);

    if (!result) {
      await db.updateExtractionStatus(memoryId, "failed");
      return;
    }

    // Empty extraction is valid — not all memories have extractable entities
    if (
      result.entities.length === 0 &&
      result.relationships.length === 0 &&
      result.tags.length === 0
    ) {
      await db.updateExtractionStatus(memoryId, "complete");
      return;
    }

    // Generate embeddings for entity names (for entity vector search)
    let entityEmbeddings: Map<string, number[]> | undefined;
    if (result.entities.length > 0) {
      try {
        const names = result.entities.map((e) => e.name);
        const vectors = await embeddings.embedBatch(names);
        entityEmbeddings = new Map(names.map((n, i) => [n, vectors[i]]));
      } catch (err) {
        logger.debug?.(`memory-neo4j: entity embedding generation failed: ${String(err)}`);
      }
    }

    // MERGE Entity nodes
    for (const entity of result.entities) {
      try {
        await db.mergeEntity({
          id: randomUUID(),
          name: entity.name,
          type: entity.type,
          aliases: entity.aliases,
          description: entity.description,
          embedding: entityEmbeddings?.get(entity.name),
        });

        // Create MENTIONS relationship
        await db.createMentions(memoryId, entity.name, "context", 1.0);
      } catch (err) {
        logger.warn(`memory-neo4j: entity merge failed for "${entity.name}": ${String(err)}`);
      }
    }

    // Create inter-Entity relationships
    for (const rel of result.relationships) {
      try {
        await db.createEntityRelationship(rel.source, rel.target, rel.type, rel.confidence);
      } catch (err) {
        logger.debug?.(
          `memory-neo4j: relationship creation failed: ${rel.source}->${rel.target}: ${String(err)}`,
        );
      }
    }

    // Tag the memory
    for (const tag of result.tags) {
      try {
        await db.tagMemory(memoryId, tag.name, tag.category);
      } catch (err) {
        logger.debug?.(`memory-neo4j: tagging failed for "${tag.name}": ${String(err)}`);
      }
    }

    await db.updateExtractionStatus(memoryId, "complete");
    logger.info(
      `memory-neo4j: extraction complete for ${memoryId.slice(0, 8)} — ` +
        `${result.entities.length} entities, ${result.relationships.length} rels, ${result.tags.length} tags`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: extraction failed for ${memoryId.slice(0, 8)}: ${String(err)}`);
    await db.updateExtractionStatus(memoryId, "failed").catch(() => {});
  }
}

// ============================================================================
// Auto-Capture Decision
// ============================================================================

/**
 * Evaluate user messages and decide what's worth storing as long-term memory.
 * Returns a list of memory items to store, or empty if nothing worth keeping.
 */
export async function evaluateAutoCapture(
  userMessages: string[],
  config: ExtractionConfig,
): Promise<CaptureItem[]> {
  if (!config.enabled || userMessages.length === 0) {
    return [];
  }

  const combined = userMessages.join("\n\n");
  if (combined.length < 10) {
    return [];
  }

  const prompt = AUTO_CAPTURE_PROMPT.replace("{messages}", combined);

  try {
    const content = await callOpenRouter(config, prompt);
    if (!content) {
      return [];
    }

    const parsed = JSON.parse(content) as Record<string, unknown>;
    return validateCaptureDecision(parsed);
  } catch {
    // Silently fail — auto-capture is best-effort
    return [];
  }
}

/**
 * Validate and sanitize the auto-capture LLM output.
 */
function validateCaptureDecision(raw: Record<string, unknown>): CaptureItem[] {
  const memories = Array.isArray(raw.memories) ? raw.memories : [];

  const validCategories = new Set<string>(["preference", "fact", "decision", "entity", "other"]);

  return memories
    .filter(
      (m: unknown): m is Record<string, unknown> =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as Record<string, unknown>).text === "string" &&
        (m as Record<string, unknown>).text !== "",
    )
    .map((m) => ({
      text: String(m.text).slice(0, 2000), // cap length
      category: validCategories.has(String(m.category))
        ? (String(m.category) as MemoryCategory)
        : "other",
      importance: typeof m.importance === "number" ? Math.min(1, Math.max(0, m.importance)) : 0.7,
    }))
    .slice(0, 5); // Max 5 captures per conversation
}

// ============================================================================
// Message Extraction Helper
// ============================================================================

/**
 * Extract user message texts from the event.messages array.
 * Handles both string content and content block arrays.
 */
export function extractUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;

    // Only process user messages for auto-capture
    if (msgObj.role !== "user") {
      continue;
    }

    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          (block as Record<string, unknown>).type === "text" &&
          "text" in block &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          texts.push((block as Record<string, unknown>).text as string);
        }
      }
    }
  }

  // Filter out noise
  return texts.filter(
    (t) => t.length >= 10 && !t.includes("<relevant-memories>") && !t.includes("<system>"),
  );
}
