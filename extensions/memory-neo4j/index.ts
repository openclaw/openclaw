/**
 * OpenClaw Memory (Neo4j) Plugin
 *
 * Drop-in replacement for memory-lancedb with three-signal hybrid search,
 * entity extraction, and knowledge graph capabilities.
 *
 * Provides:
 * - memory_recall: Hybrid search (vector + BM25 + graph traversal)
 * - memory_store: Store memories with background entity extraction
 * - memory_forget: Delete memories with cascade cleanup
 *
 * Architecture decisions: see docs/memory-neo4j/ARCHITECTURE.md
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { stringEnum } from "openclaw/plugin-sdk";
import type { Logger, MemoryCategory, MemorySource } from "./schema.js";
import { passesAttentionGate, passesAssistantAttentionGate } from "./attention-gate.js";
import { registerCli } from "./cli.js";
import {
  DEFAULT_EMBEDDING_DIMS,
  EMBEDDING_DIMENSIONS,
  MEMORY_CATEGORIES,
  memoryNeo4jConfigSchema,
  resolveExtractionConfig,
  vectorDimsForModel,
} from "./config.js";
import { Embeddings } from "./embeddings.js";
import { isSemanticDuplicate, rateImportance } from "./extractor.js";
import { extractUserMessages, extractAssistantMessages } from "./message-utils.js";
import { Neo4jMemoryClient } from "./neo4j-client.js";
import { hybridSearch } from "./search.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryNeo4jPlugin = {
  id: "memory-neo4j",
  name: "Memory (Neo4j)",
  description:
    "Neo4j-backed long-term memory with three-signal hybrid search, entity extraction, and knowledge graph",
  kind: "memory" as const,
  configSchema: memoryNeo4jConfigSchema,

  register(api: OpenClawPluginApi) {
    // Parse configuration
    const cfg = memoryNeo4jConfigSchema.parse(api.pluginConfig);
    const extractionConfig = resolveExtractionConfig(cfg.extraction);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    // Warn on empty neo4j password (may be valid for some setups, but usually a misconfiguration)
    if (!cfg.neo4j.password) {
      api.logger.warn(
        "memory-neo4j: neo4j.password is empty — this may be intentional for passwordless setups, but verify your configuration",
      );
    }

    // Warn when using default embedding dimensions for an unknown model
    const isKnownModel =
      cfg.embedding.model in EMBEDDING_DIMENSIONS ||
      Object.keys(EMBEDDING_DIMENSIONS).some((known) => cfg.embedding.model.startsWith(known));
    if (!isKnownModel) {
      api.logger.warn(
        `memory-neo4j: unknown embedding model "${cfg.embedding.model}" — using default ${DEFAULT_EMBEDDING_DIMS} dimensions. ` +
          `If your model outputs a different dimension, vector operations will fail. ` +
          `Known models: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
      );
    }

    // Create shared resources
    const db = new Neo4jMemoryClient(
      cfg.neo4j.uri,
      cfg.neo4j.username,
      cfg.neo4j.password,
      vectorDim,
      api.logger,
    );
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.provider,
      cfg.embedding.baseUrl,
      api.logger,
    );

    api.logger.debug?.(
      `memory-neo4j: registered (uri: ${cfg.neo4j.uri}, provider: ${cfg.embedding.provider}, model: ${cfg.embedding.model}, ` +
        `extraction: ${extractionConfig.enabled ? extractionConfig.model : "disabled"})`,
    );

    // ========================================================================
    // Tools (using factory pattern for agentId)
    // ========================================================================

    // memory_recall — Three-signal hybrid search
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        return {
          name: "memory_recall",
          label: "Memory Recall",
          description:
            "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.",
          parameters: Type.Object({
            query: Type.String({ description: "Search query" }),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, limit: rawLimit = 5 } = params as {
              query: string;
              limit?: number;
            };
            const limit = Math.floor(Math.min(50, Math.max(1, rawLimit)));

            const results = await hybridSearch(
              db,
              embeddings,
              query,
              limit,
              agentId,
              extractionConfig.enabled,
              { graphSearchDepth: cfg.graphSearchDepth, logger: api.logger },
            );

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.category}] ${r.text} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");

            const sanitizedResults = results.map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              importance: r.importance,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} memories:\n\n${text}`,
                },
              ],
              details: { count: results.length, memories: sanitizedResults },
            };
          },
        };
      },
      { name: "memory_recall" },
    );

    // memory_store — Store with background entity extraction
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        const sessionKey = ctx.sessionKey;
        return {
          name: "memory_store",
          label: "Memory Store",
          description:
            "Save important information in long-term memory. Use for preferences, facts, decisions.",
          parameters: Type.Object({
            text: Type.String({ description: "Information to remember" }),
            importance: Type.Optional(
              Type.Number({
                description: "Importance 0-1 (default: 0.7)",
              }),
            ),
            category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const {
              text,
              importance = 0.7,
              category = "other",
            } = params as {
              text: string;
              importance?: number;
              category?: MemoryCategory;
            };

            // 1. Generate embedding
            const vector = await embeddings.embed(text);

            // 2. Check for duplicates (vector similarity > 0.95)
            const existing = await db.findSimilar(vector, 0.95, 1, agentId);
            if (existing.length > 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing[0].text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing[0].id,
                  existingText: existing[0].text,
                },
              };
            }

            // 3. Store memory immediately (fast path)
            // User-stored core memories get pinned: importance locked at 1.0,
            // immune from decay, scoring recalculation, and pruning.
            const isUserPinnedCore = category === "core";
            const memoryId = randomUUID();
            await db.storeMemory({
              id: memoryId,
              text,
              embedding: vector,
              importance: isUserPinnedCore ? 1.0 : Math.min(1, Math.max(0, importance)),
              category,
              source: "user" as MemorySource,
              extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
              agentId,
              sessionKey,
              userPinned: isUserPinnedCore,
            });

            // 4. Extraction is deferred to sleep cycle (like human memory consolidation)
            // See: runSleepCycleExtraction() and `openclaw memory sleep` command

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
                },
              ],
              details: { action: "created", id: memoryId },
            };
          },
        };
      },
      { name: "memory_store" },
    );

    // memory_forget — Delete with cascade
    api.registerTool(
      (ctx) => {
        const agentId = ctx.agentId || "default";
        return {
          name: "memory_forget",
          label: "Memory Forget",
          description: "Delete specific memories. GDPR-compliant.",
          parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "Search to find memory" })),
            memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
          }),
          async execute(_toolCallId: string, params: unknown) {
            const { query, memoryId } = params as {
              query?: string;
              memoryId?: string;
            };

            // Direct delete by ID
            if (memoryId) {
              const deleted = await db.deleteMemory(memoryId, agentId);
              if (!deleted) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Memory ${memoryId} not found.`,
                    },
                  ],
                  details: { action: "not_found", id: memoryId },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Memory ${memoryId} forgotten.`,
                  },
                ],
                details: { action: "deleted", id: memoryId },
              };
            }

            // Search-based delete
            if (query) {
              const vector = await embeddings.embed(query);
              const results = await db.vectorSearch(vector, 5, 0.7, agentId);

              if (results.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              // Auto-delete if single high-confidence match (0.95 threshold
              // reduces false positives — 0.9 cosine similarity is not exact match)
              if (results.length === 1 && results[0].score > 0.95) {
                await db.deleteMemory(results[0].id, agentId);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].text}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              // Multiple candidates — ask user to specify
              const list = results.map((r) => `- [${r.id}] ${r.text.slice(0, 60)}...`).join("\n");

              const sanitizedCandidates = results.map((r) => ({
                id: r.id,
                text: r.text,
                category: r.category,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: {
                  action: "candidates",
                  candidates: sanitizedCandidates,
                },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          },
        };
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands (delegated to cli.ts)
    // ========================================================================

    registerCli(api, { db, embeddings, cfg, extractionConfig, vectorDim });

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Track sessions where core memories have already been loaded (skip on subsequent turns).
    // NOTE: This is in-memory and will be cleared on gateway restart. The agent_bootstrap
    // hook below also checks for existing conversation history to avoid re-injecting core
    // memories after restarts.
    const bootstrappedSessions = new Set<string>();
    const coreMemoryIdsBySession = new Map<string, Set<string>>();

    // Track mid-session refresh: maps sessionKey → tokens at last refresh
    // Used to avoid refreshing too frequently (only refresh after significant context growth)
    const midSessionRefreshAt = new Map<string, number>();
    const MIN_TOKENS_SINCE_REFRESH = 10_000; // Only refresh if context grew by 10k+ tokens

    // Track session timestamps for TTL-based cleanup. Without this, bootstrappedSessions
    // and midSessionRefreshAt leak entries for sessions that ended without an explicit
    // after_compaction event (e.g., normal session end on long-running gateways).
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const sessionLastSeen = new Map<string, number>();
    let lastTtlSweep = Date.now();

    /** Evict stale entries from session tracking maps older than SESSION_TTL_MS. */
    function pruneStaleSessionEntries(): void {
      const now = Date.now();
      // Only sweep at most once per 5 minutes to avoid overhead
      if (now - lastTtlSweep < 5 * 60 * 1000) {
        return;
      }
      lastTtlSweep = now;

      const cutoff = now - SESSION_TTL_MS;
      for (const [key, ts] of sessionLastSeen) {
        if (ts < cutoff) {
          bootstrappedSessions.delete(key);
          midSessionRefreshAt.delete(key);
          coreMemoryIdsBySession.delete(key);
          sessionLastSeen.delete(key);
        }
      }
    }

    /** Mark a session as recently active for TTL tracking. */
    function touchSession(sessionKey: string): void {
      sessionLastSeen.set(sessionKey, Date.now());
      pruneStaleSessionEntries();
    }

    // After compaction: clear bootstrap flag and mid-session refresh tracking
    if (cfg.coreMemory.enabled) {
      api.on("after_compaction", async (_event, ctx) => {
        if (ctx.sessionKey) {
          bootstrappedSessions.delete(ctx.sessionKey);
          midSessionRefreshAt.delete(ctx.sessionKey);
          coreMemoryIdsBySession.delete(ctx.sessionKey);
          sessionLastSeen.delete(ctx.sessionKey);
          api.logger.info?.(
            `memory-neo4j: cleared bootstrap/refresh flags for session ${ctx.sessionKey} after compaction`,
          );
        }
      });
    }

    // Session end: clear bootstrap flag so core memories are re-injected on the next turn.
    // Fired by /new and /reset commands. Uses sessionKey (which is how bootstrappedSessions
    // is keyed), with sessionId as fallback for implementations that only provide sessionId.
    api.on("session_end", async (_event, ctx) => {
      const key = ctx.sessionKey ?? ctx.sessionId;
      if (key) {
        bootstrappedSessions.delete(key);
        midSessionRefreshAt.delete(key);
        coreMemoryIdsBySession.delete(key);
        sessionLastSeen.delete(key);
        api.logger.info?.(
          `memory-neo4j: cleared bootstrap/refresh flags for session=${key} (session_end)`,
        );
      }
    });

    // Mid-session core memory refresh: re-inject core memories when context grows past threshold
    // This counters the "lost in the middle" phenomenon by placing core memories closer to end of context
    const refreshThreshold = cfg.coreMemory.refreshAtContextPercent;
    if (cfg.coreMemory.enabled && refreshThreshold) {
      api.logger.debug?.(
        `memory-neo4j: registering before_agent_start hook for mid-session core refresh at ${refreshThreshold}%`,
      );
      api.on("before_agent_start", async (event, ctx) => {
        // Skip if context info not available
        if (!event.contextWindowTokens || !event.estimatedUsedTokens) {
          return;
        }

        const sessionKey = ctx.sessionKey ?? "";
        const agentId = ctx.agentId || "default";
        const usagePercent = (event.estimatedUsedTokens / event.contextWindowTokens) * 100;

        // Only refresh if we've crossed the threshold
        if (usagePercent < refreshThreshold) {
          return;
        }

        // Check if we've already refreshed recently (prevent over-refreshing)
        const lastRefreshTokens = midSessionRefreshAt.get(sessionKey) ?? 0;
        const tokensSinceRefresh = event.estimatedUsedTokens - lastRefreshTokens;
        if (tokensSinceRefresh < MIN_TOKENS_SINCE_REFRESH) {
          api.logger.debug?.(
            `memory-neo4j: skipping mid-session refresh (only ${tokensSinceRefresh} tokens since last refresh)`,
          );
          return;
        }

        try {
          const t0 = performance.now();
          const maxEntries = cfg.coreMemory.maxEntries;
          const coreMemories = await db.listCoreForInjection(maxEntries, agentId);

          if (coreMemories.length === 0) {
            return;
          }

          // Record this refresh
          midSessionRefreshAt.set(sessionKey, event.estimatedUsedTokens);
          touchSession(sessionKey);

          const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
          const totalMs = performance.now() - t0;
          api.logger.info?.(
            `memory-neo4j: [bench] core-refresh ${totalMs.toFixed(0)}ms at ${usagePercent.toFixed(1)}% context (${coreMemories.length} memories)`,
          );

          return {
            prependContext: `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`,
          };
        } catch (err) {
          api.logger.warn(`memory-neo4j: mid-session core refresh failed: ${String(err)}`);
        }
      });
    }

    // Auto-recall: inject relevant memories before agent starts
    api.logger.debug?.(`memory-neo4j: autoRecall=${cfg.autoRecall}`);
    if (cfg.autoRecall) {
      api.logger.debug?.("memory-neo4j: registering before_agent_start hook for auto-recall");
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) {
          return;
        }

        // Skip auto-recall for voice/realtime sessions where latency is critical.
        // These sessions use short conversational turns that don't benefit from
        // memory injection, and the ~100-300ms embedding+search overhead matters.
        const sessionKey = ctx.sessionKey ?? "";
        if (cfg.autoRecallSkipPattern && cfg.autoRecallSkipPattern.test(sessionKey)) {
          api.logger.debug?.(
            `memory-neo4j: skipping auto-recall for session ${sessionKey} (matches skipPattern)`,
          );
          return;
        }

        const agentId = ctx.agentId || "default";

        // ~1000 chars keeps us safely within even small embedding contexts
        // (mxbai-embed-large = 512 tokens). Longer recall queries don't improve
        // embedding quality — it plateaus well before this limit.
        const MAX_QUERY_CHARS = 1000;
        const query =
          event.prompt.length > MAX_QUERY_CHARS
            ? event.prompt.slice(0, MAX_QUERY_CHARS)
            : event.prompt;

        try {
          const t0 = performance.now();
          let results = await hybridSearch(
            db,
            embeddings,
            query,
            3,
            agentId,
            extractionConfig.enabled,
            { graphSearchDepth: cfg.graphSearchDepth, logger: api.logger },
          );
          const tSearch = performance.now();

          // Feature 1: Filter out low-relevance results below min RRF score
          results = results.filter((r) => r.score >= cfg.autoRecallMinScore);

          // Feature 2: Deduplicate against core memories already in context
          const sessionKey = ctx.sessionKey ?? "";
          const coreIds = coreMemoryIdsBySession.get(sessionKey);
          if (coreIds) {
            results = results.filter((r) => !coreIds.has(r.id));
          }

          const totalMs = performance.now() - t0;
          api.logger.info?.(
            `memory-neo4j: [bench] auto-recall ${totalMs.toFixed(0)}ms total (search=${(tSearch - t0).toFixed(0)}ms), ${results.length} results`,
          );

          if (results.length === 0) {
            return;
          }

          const memoryContext = results.map((r) => `- [${r.category}] ${r.text}`).join("\n");

          api.logger.debug?.(
            `memory-neo4j: auto-recall memories: ${JSON.stringify(results.map((r) => ({ id: r.id, text: r.text.slice(0, 80), category: r.category, score: r.score })))}`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-neo4j: auto-recall failed: ${String(err)}`);
        }
      });
    }

    // Core memories: inject as virtual MEMORY.md at bootstrap time (scoped by agentId).
    // Only runs on new sessions and after compaction (not every turn).
    api.logger.debug?.(`memory-neo4j: coreMemory.enabled=${cfg.coreMemory.enabled}`);
    if (cfg.coreMemory.enabled) {
      api.logger.debug?.("memory-neo4j: registering agent_bootstrap hook for core memories");
      api.on("agent_bootstrap", async (event, ctx) => {
        const sessionKey = ctx.sessionKey;

        // Skip if this session was already bootstrapped (avoid re-loading every turn).
        // The after_compaction hook clears the flag so we re-inject after compaction.
        if (sessionKey && bootstrappedSessions.has(sessionKey)) {
          api.logger.debug?.(
            `memory-neo4j: skipping core memory injection for already-bootstrapped session=${sessionKey}`,
          );
          return;
        }

        // Log when we're about to inject core memories for a session that wasn't tracked
        // This helps diagnose cases where context might be lost after gateway restarts
        if (sessionKey) {
          api.logger.debug?.(
            `memory-neo4j: session=${sessionKey} not in bootstrappedSessions (size=${bootstrappedSessions.size}), will check for core memories`,
          );
        }

        try {
          const t0 = performance.now();
          const agentId = ctx.agentId || "default";
          const maxEntries = cfg.coreMemory.maxEntries;

          api.logger.debug?.(
            `memory-neo4j: loading core memories for agent=${agentId} session=${sessionKey ?? "unknown"}`,
          );
          // All user-pinned core memories are always included (no limit).
          // Non-pinned core memories fill remaining slots up to maxEntries, ordered by importance.
          const coreMemories = await db.listCoreForInjection(maxEntries, agentId);
          const tQuery = performance.now();

          if (coreMemories.length === 0) {
            if (sessionKey) {
              bootstrappedSessions.add(sessionKey);
              touchSession(sessionKey);
            }
            api.logger.info?.(
              `memory-neo4j: [bench] core-inject ${(tQuery - t0).toFixed(0)}ms (0 memories, skipped)`,
            );
            return;
          }

          // Format core memories into a MEMORY.md-style document
          let content = "# Core Memory\n\n";
          content += "*Persistent context loaded from long-term memory*\n\n";
          for (const mem of coreMemories) {
            content += `- ${mem.text}\n`;
          }

          // Find and replace MEMORY.md in the files list, or add it
          const files = [...event.files];
          const memoryIndex = files.findIndex(
            (f) => f.name === "MEMORY.md" || f.name === "memory.md",
          );

          const virtualFile = {
            name: "MEMORY.md" as const,
            path: "memory://neo4j/core-memory",
            content,
            missing: false,
          };

          const action = memoryIndex >= 0 ? "replaced" : "added";
          if (memoryIndex >= 0) {
            files[memoryIndex] = virtualFile;
          } else {
            files.push(virtualFile);
          }

          if (sessionKey) {
            bootstrappedSessions.add(sessionKey);
            coreMemoryIdsBySession.set(sessionKey, new Set(coreMemories.map((m) => m.id)));
            touchSession(sessionKey);
          }

          const totalMs = performance.now() - t0;
          api.logger.info?.(
            `memory-neo4j: [bench] core-inject ${totalMs.toFixed(0)}ms (query=${(tQuery - t0).toFixed(0)}ms), ${action} MEMORY.md with ${coreMemories.length} memories`,
          );

          return { files };
        } catch (err) {
          api.logger.warn(`memory-neo4j: core memory injection failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: attention-gated memory pipeline modeled on human memory.
    //
    // Phase 1 — Attention gating (real-time):
    //   Lightweight heuristic filter rejects obvious noise (greetings, short
    //   acks, system markup, code dumps) without any LLM call.
    //
    // Phase 2 — Short-term retention:
    //   Everything that passes the gate is embedded, deduped, and stored as
    //   regular memory with extractionStatus "pending".
    //
    // Phase 3 — Sleep consolidation (deferred to `openclaw memory neo4j sleep`):
    //   The sleep cycle handles entity extraction, categorization, Pareto
    //   scoring, promotion, and decay — mirroring hippocampal replay.
    api.logger.debug?.(
      `memory-neo4j: autoCapture=${cfg.autoCapture}, extraction.enabled=${extractionConfig.enabled}`,
    );
    if (cfg.autoCapture) {
      api.logger.debug?.("memory-neo4j: registering agent_end hook for auto-capture");
      api.on("agent_end", (event, ctx) => {
        api.logger.debug?.(
          `memory-neo4j: agent_end fired (success=${event.success}, messages=${event.messages?.length ?? 0})`,
        );
        if (!event.success || !event.messages || event.messages.length === 0) {
          api.logger.debug?.("memory-neo4j: skipping - no success or empty messages");
          return;
        }

        // Skip auto-capture for sessions matching the skip pattern (e.g. voice sessions)
        const sessionKey = ctx.sessionKey;
        if (
          cfg.autoCaptureSkipPattern &&
          sessionKey &&
          cfg.autoCaptureSkipPattern.test(sessionKey)
        ) {
          api.logger.debug?.(
            `memory-neo4j: skipping auto-capture for session ${sessionKey} (matches skipPattern)`,
          );
          return;
        }

        const agentId = ctx.agentId || "default";

        // Fire-and-forget: run auto-capture asynchronously so it doesn't
        // block the agent_end hook (which otherwise adds 2-10s per turn).
        void runAutoCapture(
          event.messages,
          agentId,
          sessionKey,
          db,
          embeddings,
          extractionConfig,
          api.logger,
        );
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-neo4j",
      start: async () => {
        try {
          await db.ensureInitialized();
          api.logger.info(
            `memory-neo4j: service started (uri: ${cfg.neo4j.uri}, model: ${cfg.embedding.model})`,
          );
        } catch (err) {
          api.logger.error(
            `memory-neo4j: failed to start — ${String(err)}. Memory tools will attempt lazy initialization.`,
          );
          // Don't throw — allow graceful degradation.
          // Tools will retry initialization on first use.
        }
      },
      stop: async () => {
        await db.close();
        api.logger.info("memory-neo4j: service stopped");
      },
    });
  },
};

// ============================================================================
// Auto-capture pipeline (fire-and-forget from agent_end hook)
// ============================================================================

/**
 * Shared capture logic for both user and assistant messages.
 * Extracts the common embed → dedup → rate → store pipeline.
 */
async function captureMessage(
  text: string,
  source: "auto-capture" | "auto-capture-assistant",
  importanceThreshold: number,
  importanceDiscount: number,
  agentId: string,
  sessionKey: string | undefined,
  db: import("./neo4j-client.js").Neo4jMemoryClient,
  embeddings: import("./embeddings.js").Embeddings,
  extractionConfig: import("./config.js").ExtractionConfig,
  logger: Logger,
  precomputedVector?: number[],
): Promise<{ stored: boolean; semanticDeduped: boolean }> {
  // For assistant messages, rate importance first (before embedding) to skip early.
  // When extraction is disabled, rateImportance returns 0.5 (the fallback), so we
  // skip the early importance gate to avoid silently blocking all assistant captures.
  const rateFirst = source === "auto-capture-assistant" && extractionConfig.enabled;

  let importance: number | undefined;
  if (rateFirst) {
    importance = await rateImportance(text, extractionConfig);
    if (importance < importanceThreshold) {
      return { stored: false, semanticDeduped: false };
    }
  }

  const vector = precomputedVector ?? (await embeddings.embed(text));

  // Single vector search at lower threshold, split by score band
  const candidates = await db.findSimilar(vector, 0.75, 3, agentId);

  // Exact dedup: any candidate with score >= 0.95 means it's a duplicate
  const exactDup = candidates.find((c) => c.score >= 0.95);
  if (exactDup) {
    return { stored: false, semanticDeduped: false };
  }

  // Rate importance if not already done.
  // When extraction is disabled, rateImportance returns a fixed 0.5 fallback,
  // so skip the threshold check to avoid silently blocking all captures.
  if (importance === undefined) {
    importance = await rateImportance(text, extractionConfig);
    if (extractionConfig.enabled && importance < importanceThreshold) {
      return { stored: false, semanticDeduped: false };
    }
  }

  // Semantic dedup: remaining candidates in 0.75-0.95 band
  // Pass the vector similarity score as a pre-screen to skip LLM calls
  // for pairs below SEMANTIC_DEDUP_VECTOR_THRESHOLD.
  if (candidates.length > 0) {
    for (const candidate of candidates) {
      if (await isSemanticDuplicate(text, candidate.text, extractionConfig, candidate.score)) {
        logger.debug?.(
          `memory-neo4j: semantic dedup — skipped "${text.slice(0, 60)}..." (duplicate of "${candidate.text.slice(0, 60)}...")`,
        );
        return { stored: false, semanticDeduped: true };
      }
    }
  }

  await db.storeMemory({
    id: randomUUID(),
    text,
    embedding: vector,
    importance: importance * importanceDiscount,
    category: "other",
    source,
    extractionStatus: extractionConfig.enabled ? "pending" : "skipped",
    agentId,
    sessionKey,
  });
  return { stored: true, semanticDeduped: false };
}

/**
 * Run the full auto-capture pipeline asynchronously.
 * Processes user and assistant messages through attention gate → capture.
 */
async function runAutoCapture(
  messages: unknown[],
  agentId: string,
  sessionKey: string | undefined,
  db: import("./neo4j-client.js").Neo4jMemoryClient,
  embeddings: import("./embeddings.js").Embeddings,
  extractionConfig: import("./config.js").ExtractionConfig,
  logger: Logger,
): Promise<void> {
  try {
    const t0 = performance.now();
    let stored = 0;
    let semanticDeduped = 0;

    // Process user messages
    const userMessages = extractUserMessages(messages);
    const retained = userMessages.filter((text) => passesAttentionGate(text));

    // Process assistant messages
    const assistantMessages = extractAssistantMessages(messages);
    const retainedAssistant = assistantMessages.filter((text) =>
      passesAssistantAttentionGate(text),
    );
    const tGate = performance.now();

    // Collect all texts to embed in a single batch
    const allTexts: string[] = [];
    const allMeta: Array<{
      text: string;
      source: "auto-capture" | "auto-capture-assistant";
      threshold: number;
      discount: number;
    }> = [];

    for (const text of retained) {
      allTexts.push(text);
      allMeta.push({ text, source: "auto-capture", threshold: 0.5, discount: 1.0 });
    }
    for (const text of retainedAssistant) {
      allTexts.push(text);
      allMeta.push({ text, source: "auto-capture-assistant", threshold: 0.8, discount: 0.75 });
    }

    // Batch embed all at once
    const vectors = allTexts.length > 0 ? await embeddings.embedBatch(allTexts) : [];
    const tEmbed = performance.now();

    // Process each with pre-computed vector
    for (let i = 0; i < allMeta.length; i++) {
      try {
        const meta = allMeta[i];
        const result = await captureMessage(
          meta.text,
          meta.source,
          meta.threshold,
          meta.discount,
          agentId,
          sessionKey,
          db,
          embeddings,
          extractionConfig,
          logger,
          vectors[i],
        );
        if (result.stored) stored++;
        if (result.semanticDeduped) semanticDeduped++;
      } catch (err) {
        logger.debug?.(`memory-neo4j: auto-capture item failed: ${String(err)}`);
      }
    }
    const tProcess = performance.now();

    const totalMs = tProcess - t0;
    const gateMs = tGate - t0;
    const embedMs = tEmbed - tGate;
    const processMs = tProcess - tEmbed;
    logger.info(
      `memory-neo4j: [bench] auto-capture ${totalMs.toFixed(0)}ms total (gate=${gateMs.toFixed(0)}ms, embed=${embedMs.toFixed(0)}ms, process=${processMs.toFixed(0)}ms), ` +
        `${retained.length}+${retainedAssistant.length} gated, ${stored} stored, ${semanticDeduped} deduped`,
    );
  } catch (err) {
    logger.warn(`memory-neo4j: auto-capture failed: ${String(err)}`);
  }
}

// Export auto-capture internals for testing
export { captureMessage as _captureMessage, runAutoCapture as _runAutoCapture };

// ============================================================================
// Export
// ============================================================================

export default memoryNeo4jPlugin;
