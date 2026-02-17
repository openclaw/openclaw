/**
 * LLM-based entity extraction and memory operations for memory-neo4j.
 *
 * Extraction uses a configurable OpenAI-compatible LLM (OpenRouter, Ollama, etc.) to:
 * - Extract entities, relationships, and tags from stored memories
 * - Classify memories into categories (preference, fact, decision, etc.)
 * - Rate memory importance on a 1-10 scale
 * - Detect semantic duplicates via LLM comparison
 * - Resolve conflicting memories
 *
 * Runs as background fire-and-forget operations with graceful degradation.
 */

import { randomUUID } from "node:crypto";
import type { ExtractionConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { EntityType, ExtractionResult, Logger, MemoryCategory } from "./schema.js";
import { callOpenRouter, callOpenRouterStream, isTransientError } from "./llm-client.js";
import { ALLOWED_RELATIONSHIP_TYPES, ENTITY_TYPES, MEMORY_CATEGORIES } from "./schema.js";

// ============================================================================
// Extraction Prompt
// ============================================================================

// System instruction (no user data) — user message contains the memory text
const ENTITY_EXTRACTION_SYSTEM = `You are an entity extraction system for a personal memory store.
Extract entities and relationships from the memory text provided by the user, and classify the memory.

Return JSON:
{
  "category": "preference|fact|decision|entity|other",
  "entities": [
    {"name": "alice", "type": "person", "aliases": ["manager"], "description": "brief description"}
  ],
  "relationships": [
    {"source": "alice", "target": "acme corp", "type": "WORKS_AT", "confidence": 0.95}
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
- Only extract SPECIFIC named entities: real people, companies, products, tools, places, events
- Do NOT extract generic technology terms (python, javascript, docker, linux, api, sql, html, css, json, etc.)
- Do NOT extract generic concepts (meeting, project, training, email, code, data, server, file, script, etc.)
- Do NOT extract programming abstractions (function, class, module, async, sync, process, etc.)
- Good entities: "Tarun", "Abundent Academy", "Tioman Island", "LiveKit", "Neo4j", "Fish Speech S1 Mini"
- Bad entities: "python", "ai", "automation", "email", "docker", "machine learning", "api"
- When in doubt, do NOT extract — fewer high-quality entities beat many generic ones
- Keep entity descriptions brief (1 sentence max)
- Category: "preference" for opinions/preferences, "fact" for factual info, "decision" for choices made, "entity" for entity-focused, "other" for miscellaneous
- ALWAYS generate at least 2 tags. Every memory has a topic — there are no exceptions.
- Tags describe the TOPIC or DOMAIN of the memory, not the entities themselves.
- Do NOT use entity names as tags (e.g., don't tag "tarun" if Tarun is already an entity).
- Good tags: "travel planning", "family", "voice synthesis", "linkedin automation", "expense tracking", "cron scheduling", "api integration"
- Tag categories: "topic", "domain", "workflow", "technology", "personal", "business"
- Return empty entity/relationship arrays if nothing specific to extract, but NEVER return empty tags.`;

// ============================================================================
// Retroactive Tagging Prompt
// ============================================================================

/**
 * Lightweight prompt for retroactive tagging of memories that were extracted
 * without tags. Only asks for tags — no entities or relationships.
 */
const RETROACTIVE_TAGGING_SYSTEM = `You are a topic tagging system for a personal memory store.
Generate 2-4 topic tags that describe what this memory is about.

Return JSON:
{
  "tags": [
    {"name": "tag name", "category": "topic|domain|workflow|technology|personal|business"}
  ]
}

Rules:
- Tags describe the TOPIC or DOMAIN of the memory, not specific people or tools mentioned.
- Good tags: "travel planning", "family", "voice synthesis", "linkedin automation", "expense tracking", "cron scheduling", "api integration", "system configuration", "memory management"
- Bad tags: names of people, companies, or specific tools (those are entities, not topics)
- Tag categories: "topic" (general subject), "domain" (field/area), "workflow" (process/procedure), "technology" (tech area), "personal" (personal life), "business" (work/business)
- ALWAYS return at least 2 tags. Every memory has a topic.
- Normalize tag names to lowercase with spaces (no hyphens or underscores).`;

// ============================================================================
// Entity Extraction
// ============================================================================

/**
 * Max retries for transient extraction failures before marking permanently failed.
 *
 * Retry budget accounting — two layers of retry:
 *   Layer 1: callOpenRouter/callOpenRouterStream internal retries (config.maxRetries, default 2 = 3 attempts)
 *   Layer 2: Sleep cycle retries (MAX_EXTRACTION_RETRIES = 3 sleep cycles)
 *   Total worst-case: 3 × 3 = 9 LLM attempts per memory
 */
const MAX_EXTRACTION_RETRIES = 3;

/**
 * Extract entities and relationships from a memory text using LLM.
 *
 * Uses streaming for responsive abort signal handling and better latency.
 *
 * Returns { result, transientFailure }:
 * - result is the ExtractionResult or null if extraction returned nothing useful
 * - transientFailure is true if the failure was due to a network/timeout issue
 *   (caller should retry later) vs a permanent failure (bad JSON, etc.)
 */
export async function extractEntities(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<{ result: ExtractionResult | null; transientFailure: boolean }> {
  if (!config.enabled) {
    return { result: null, transientFailure: false };
  }

  // System/user separation prevents memory text from being interpreted as instructions
  const messages = [
    { role: "system", content: ENTITY_EXTRACTION_SYSTEM },
    { role: "user", content: text },
  ];

  let content: string | null;
  try {
    // Use streaming for extraction — allows responsive abort and better latency
    content = await callOpenRouterStream(config, messages, abortSignal);
  } catch (err) {
    // Network/timeout errors are transient — caller should retry
    return { result: null, transientFailure: isTransientError(err) };
  }

  if (!content) {
    return { result: null, transientFailure: false };
  }

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return { result: validateExtractionResult(parsed), transientFailure: false };
  } catch {
    // JSON parse failure is permanent — LLM returned malformed output
    return { result: null, transientFailure: false };
  }
}

/**
 * Extract only tags from a memory text using a lightweight LLM prompt.
 * Used for retroactive tagging of memories that were extracted without tags.
 *
 * Returns an array of tags, or null on failure.
 */
export async function extractTagsOnly(
  text: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<Array<{ name: string; category: string }> | null> {
  if (!config.enabled) {
    return null;
  }

  const messages = [
    { role: "system", content: RETROACTIVE_TAGGING_SYSTEM },
    { role: "user", content: text },
  ];

  let content: string | null;
  try {
    content = await callOpenRouterStream(config, messages, abortSignal);
  } catch {
    return null;
  }

  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { tags?: unknown };
    const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
    return rawTags
      .filter(
        (t: unknown): t is Record<string, unknown> =>
          t !== null &&
          typeof t === "object" &&
          typeof (t as Record<string, unknown>).name === "string",
      )
      .map((t) => ({
        name: normalizeTagName(String(t.name)),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0);
  } catch {
    return null;
  }
}

/**
 * Normalize a tag name: lowercase, collapse hyphens/underscores to spaces,
 * collapse multiple spaces, trim. Ensures "machine-learning", "machine_learning",
 * and "machine learning" all resolve to the same tag node.
 */
function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Generic terms that should never be extracted as entities.
 * These are common technology/concept words that the LLM tends to
 * extract despite prompt instructions. Post-filter is more reliable
 * than prompt engineering alone.
 */
const GENERIC_ENTITY_BLOCKLIST = new Set([
  // Programming languages & frameworks
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "rust",
  "ruby",
  "php",
  "c",
  "c++",
  "c#",
  "swift",
  "kotlin",
  "bash",
  "shell",
  "html",
  "css",
  "sql",
  "nosql",
  "json",
  "xml",
  "yaml",
  "react",
  "vue",
  "angular",
  "svelte",
  "next.js",
  "express",
  "fastapi",
  "django",
  "flask",
  // Generic tech concepts
  "ai",
  "artificial intelligence",
  "machine learning",
  "deep learning",
  "neural network",
  "automation",
  "api",
  "rest api",
  "graphql",
  "webhook",
  "websocket",
  "database",
  "server",
  "client",
  "cloud",
  "microservice",
  "monolith",
  "frontend",
  "backend",
  "fullstack",
  "devops",
  "ci/cd",
  "deployment",
  // Generic tools/infra
  "docker",
  "kubernetes",
  "linux",
  "windows",
  "macos",
  "nginx",
  "apache",
  "git",
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "node",
  "nodejs",
  "node.js",
  // Generic work concepts
  "meeting",
  "project",
  "training",
  "email",
  "calendar",
  "task",
  "ticket",
  "code",
  "data",
  "file",
  "folder",
  "directory",
  "script",
  "module",
  "debug",
  "deploy",
  "build",
  "release",
  "update",
  "upgrade",
  "user",
  "admin",
  "system",
  "service",
  "process",
  "job",
  "worker",
  // Programming abstractions
  "function",
  "class",
  "method",
  "variable",
  "object",
  "array",
  "string",
  "async",
  "sync",
  "promise",
  "callback",
  "event",
  "hook",
  "middleware",
  "component",
  "plugin",
  "extension",
  "library",
  "package",
  "dependency",
  // Generic descriptors
  "app",
  "application",
  "web",
  "mobile",
  "desktop",
  "browser",
  "config",
  "configuration",
  "settings",
  "environment",
  "production",
  "staging",
  "error",
  "bug",
  "issue",
  "fix",
  "patch",
  "feature",
  "improvement",
]);

/**
 * Validate and sanitize LLM extraction output.
 */
function validateExtractionResult(raw: Record<string, unknown>): ExtractionResult {
  const entities = Array.isArray(raw.entities) ? raw.entities : [];
  const relationships = Array.isArray(raw.relationships) ? raw.relationships : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];

  const validEntityTypes = new Set<string>(ENTITY_TYPES);
  const validCategories = new Set<string>(MEMORY_CATEGORIES);
  const rawCategory = typeof raw.category === "string" ? raw.category : undefined;
  const category =
    rawCategory && validCategories.has(rawCategory) ? (rawCategory as MemoryCategory) : undefined;

  return {
    category,
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
      .filter((e) => e.name.length > 0 && !GENERIC_ENTITY_BLOCKLIST.has(e.name)),

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
        name: normalizeTagName(String(t.name)),
        category: typeof t.category === "string" ? t.category : "topic",
      }))
      .filter((t) => t.name.length > 0),
  };
}

// ============================================================================
// Conflict Resolution
// ============================================================================

/**
 * Use an LLM to determine whether two memories genuinely conflict.
 * Returns which memory to keep, or "both" if they don't actually conflict.
 * Returns "skip" on any failure (network, parse, disabled config).
 */
export async function resolveConflict(
  memA: string,
  memB: string,
  config: ExtractionConfig,
  abortSignal?: AbortSignal,
): Promise<"a" | "b" | "both" | "skip"> {
  if (!config.enabled) return "skip";

  try {
    const content = await callOpenRouter(
      config,
      [
        {
          role: "system",
          content: `Two memories may conflict with each other. Determine which should be kept.

If they genuinely contradict each other, keep the one that is more current, specific, or accurate.
If they don't actually conflict (they cover different aspects or are both valid), keep both.

Return JSON: {"keep": "a"|"b"|"both", "reason": "brief explanation"}`,
        },
        { role: "user", content: `Memory A: "${memA}"\nMemory B: "${memB}"` },
      ],
      abortSignal,
    );
    if (!content) return "skip";

    const parsed = JSON.parse(content) as { keep?: string };
    const keep = parsed.keep;
    if (keep === "a" || keep === "b" || keep === "both") return keep;
    return "skip";
  } catch {
    return "skip";
  }
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
 * 6. Update extractionStatus to "complete", "pending" (transient retry), or "failed"
 *
 * Transient failures (network/timeout) leave status as "pending" with an incremented
 * retry counter. After MAX_EXTRACTION_RETRIES transient failures, the memory is
 * permanently marked "failed". Permanent failures (malformed JSON) are immediately "failed".
 */
export async function runBackgroundExtraction(
  memoryId: string,
  text: string,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  config: ExtractionConfig,
  logger: Logger,
  currentRetries: number = 0,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; memoryId: string }> {
  if (!config.enabled) {
    await db.updateExtractionStatus(memoryId, "skipped").catch(() => {});
    return { success: true, memoryId };
  }

  try {
    const { result, transientFailure } = await extractEntities(text, config, abortSignal);

    if (!result) {
      if (transientFailure) {
        // Transient failure (network/timeout) — leave as pending for retry
        const retries = currentRetries + 1;
        if (retries >= MAX_EXTRACTION_RETRIES) {
          logger.warn(
            `memory-neo4j: extraction permanently failed for ${memoryId.slice(0, 8)} after ${retries} transient retries`,
          );
          await db.updateExtractionStatus(memoryId, "failed", { incrementRetries: true });
        } else {
          logger.info(
            `memory-neo4j: extraction transient failure for ${memoryId.slice(0, 8)}, will retry (${retries}/${MAX_EXTRACTION_RETRIES})`,
          );
          // Keep status as "pending" but increment retry counter
          await db.updateExtractionStatus(memoryId, "pending", { incrementRetries: true });
        }
      } else {
        // Permanent failure (JSON parse, empty response, etc.)
        await db.updateExtractionStatus(memoryId, "failed");
      }
      return { success: false, memoryId };
    }

    // Empty extraction is valid — not all memories have extractable entities
    if (
      result.entities.length === 0 &&
      result.relationships.length === 0 &&
      result.tags.length === 0
    ) {
      await db.updateExtractionStatus(memoryId, "complete");
      return { success: true, memoryId };
    }

    // Batch all entity operations into a single transaction:
    // entity merges, mentions, relationships, tags, category, and extraction status
    await db.batchEntityOperations(
      memoryId,
      result.entities.map((e) => ({
        id: randomUUID(),
        name: e.name,
        type: e.type,
        aliases: e.aliases,
        description: e.description,
      })),
      result.relationships,
      result.tags,
      result.category,
    );

    logger.info(
      `memory-neo4j: extraction complete for ${memoryId.slice(0, 8)} — ` +
        `${result.entities.length} entities, ${result.relationships.length} rels, ${result.tags.length} tags` +
        (result.category ? `, category=${result.category}` : ""),
    );

    // Post-extraction quality gate: auto-captured user messages classified as
    // "decision" or "other" are almost always contextual instructions (e.g.,
    // "Can you fix the dashboard"), not reusable knowledge. Invalidate them.
    if (result.category === "decision" || result.category === "other") {
      const source = await db.getMemoryField(memoryId, "source");
      if (source === "auto-capture") {
        await db.invalidateMemory(memoryId);
        logger.info(
          `memory-neo4j: post-extraction gate — invalidated auto-capture "${text.slice(0, 60)}..." (category=${result.category})`,
        );
        return { success: true, memoryId };
      }
    }

    return { success: true, memoryId };
  } catch (err) {
    // Unexpected error during graph operations — treat as transient if retry budget remains
    const isTransient = isTransientError(err);
    if (isTransient && currentRetries + 1 < MAX_EXTRACTION_RETRIES) {
      logger.warn(
        `memory-neo4j: extraction transient error for ${memoryId.slice(0, 8)}, will retry: ${String(err)}`,
      );
      await db
        .updateExtractionStatus(memoryId, "pending", { incrementRetries: true })
        .catch(() => {});
    } else {
      logger.warn(`memory-neo4j: extraction failed for ${memoryId.slice(0, 8)}: ${String(err)}`);
      await db
        .updateExtractionStatus(memoryId, "failed", { incrementRetries: true })
        .catch(() => {});
    }
    return { success: false, memoryId };
  }
}

// ============================================================================
// LLM-Judged Importance Rating
// ============================================================================

// System instruction — user message contains the text to rate
const IMPORTANCE_RATING_SYSTEM = `You are rating memories for a personal AI assistant's long-term memory store.
Rate how important it is to REMEMBER this information in future conversations on a scale of 1-10.

SCORING GUIDE:
1-2: Noise — greetings, filler, "let me check", status updates, system instructions, formatting rules, debugging output
3-4: Ephemeral — session-specific progress ("done, pushed to git"), temporary task status, tool output summaries
5-6: Mildly useful — general facts, minor context that might occasionally help
7-8: Important — personal preferences, key decisions, facts about people/relationships, business rules, learned workflows
9: Very important — identity facts (birthdays, family, addresses), critical business decisions, security rules
10: Essential — safety-critical information, core identity

KEY RULES:
- AI assistant self-narration ("Let me check...", "I'll now...", "Done! Here's what changed...") is ALWAYS 1-3
- System prompts, formatting instructions, voice mode rules are ALWAYS 1-2
- Technical debugging details ("the WebSocket failed because...") are 2-4 unless they encode a reusable lesson
- Open proposals and unresolved action items ("Want me to fix it?", "Should I submit a PR?", "Would you like me to proceed?") are ALWAYS 1-2. These are dangerous in long-term memory because other sessions interpret them as active instructions.
- Messages ending with questions directed at the user ("What do you think?", "How should I handle this?") are 1-3 unless they also contain substantial factual content worth remembering
- Personal facts about the user or their family/contacts are 7-10
- Business rules and operational procedures are 7-9
- Preferences and opinions expressed by the user are 6-8
- Ask: "Would this be useful if it appeared in a conversation 30 days from now?" If no, score ≤ 4.

Return JSON: {"score": N, "reason": "brief explanation"}`;

/**
 * Rate the long-term importance of a text using an LLM.
 * Returns a value between 0.1 and 1.0, or 0.5 on any failure.
 */
export async function rateImportance(text: string, config: ExtractionConfig): Promise<number> {
  if (!config.enabled) {
    return 0.5;
  }

  try {
    const content = await callOpenRouter(config, [
      { role: "system", content: IMPORTANCE_RATING_SYSTEM },
      { role: "user", content: text },
    ]);
    if (!content) {
      return 0.5;
    }

    const parsed = JSON.parse(content) as { score?: unknown };
    const score = typeof parsed.score === "number" ? parsed.score : NaN;
    if (Number.isNaN(score)) {
      return 0.5;
    }

    const clamped = Math.max(1, Math.min(10, score));
    return Math.max(0.1, Math.min(1.0, clamped / 10));
  } catch {
    return 0.5;
  }
}

// ============================================================================
// Semantic Deduplication
// ============================================================================

// System instruction — user message contains the two texts to compare
const SEMANTIC_DEDUP_SYSTEM = `You are a memory deduplication system. Determine whether the new text conveys the SAME factual information as the existing memory.

Rules:
- Return "duplicate" if the new text is conveying the same core fact(s), even if worded differently
- Return "duplicate" if the new text is a subset of information already in the existing memory
- Return "unique" if the new text contains genuinely new information not in the existing memory
- Ignore differences in formatting, pronouns, or phrasing — focus on the underlying facts

Return JSON: {"verdict": "duplicate"|"unique", "reason": "brief explanation"}`;

/**
 * Minimum cosine similarity to proceed with the LLM comparison.
 * Below this threshold, texts are too dissimilar to be semantic duplicates,
 * saving an expensive LLM call. Exported for testing.
 */
export const SEMANTIC_DEDUP_VECTOR_THRESHOLD = 0.8;

/**
 * Check whether new text is semantically a duplicate of an existing memory.
 *
 * When a pre-computed vector similarity score is provided (from findSimilar
 * or findDuplicateClusters), the LLM call is skipped entirely for pairs
 * below SEMANTIC_DEDUP_VECTOR_THRESHOLD — a fast pre-screen that avoids
 * the most expensive part of the pipeline.
 *
 * Returns true if the new text is a duplicate (should be skipped).
 * Returns false on any failure (allow storage).
 */
export async function isSemanticDuplicate(
  newText: string,
  existingText: string,
  config: ExtractionConfig,
  vectorSimilarity?: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  // Vector pre-screen: skip LLM call when similarity is below threshold
  if (vectorSimilarity !== undefined && vectorSimilarity < SEMANTIC_DEDUP_VECTOR_THRESHOLD) {
    return false;
  }

  try {
    const content = await callOpenRouter(
      config,
      [
        { role: "system", content: SEMANTIC_DEDUP_SYSTEM },
        { role: "user", content: `Existing memory: "${existingText}"\nNew text: "${newText}"` },
      ],
      abortSignal,
    );
    if (!content) {
      return false;
    }

    const parsed = JSON.parse(content) as { verdict?: string };
    return parsed.verdict === "duplicate";
  } catch {
    return false;
  }
}
