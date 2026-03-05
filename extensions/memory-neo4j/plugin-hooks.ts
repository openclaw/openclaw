/**
 * Event hook registrations for the memory-neo4j plugin.
 *
 * Registers: after_compaction, session_end, before_agent_start (×1, merged), agent_bootstrap, agent_end
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runAutoCapture } from "./auto-capture.js";
import type { ExtractionConfig, MemoryNeo4jConfig } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { Neo4jMemoryClient } from "./neo4j-client.js";
import type { Logger } from "./schema.js";
import { hybridSearch } from "./search.js";
import { isRelatedToCompletedTask, loadCompletedTaskKeywords } from "./task-filter.js";
import { parseTaskLedger } from "./task-ledger.js";

/**
 * Pure decision function for mid-session core memory refresh.
 * Exported for unit testing so tests exercise the real logic path.
 */
export function _shouldRefreshForTest(params: {
  contextWindowTokens: number | undefined;
  estimatedUsedTokens: number | undefined;
  refreshThreshold: number;
  lastRefreshTokens: number;
  minTokensSinceRefresh: number;
}): boolean {
  const {
    contextWindowTokens,
    estimatedUsedTokens,
    refreshThreshold,
    lastRefreshTokens,
    minTokensSinceRefresh,
  } = params;
  if (!contextWindowTokens || !estimatedUsedTokens) {
    return false;
  }
  const usagePercent = (estimatedUsedTokens / contextWindowTokens) * 100;
  if (usagePercent < refreshThreshold) {
    return false;
  }
  const tokensSinceRefresh = estimatedUsedTokens - lastRefreshTokens;
  if (tokensSinceRefresh < minTokensSinceRefresh) {
    return false;
  }
  return true;
}

export function registerMemoryHooks(
  api: OpenClawPluginApi,
  db: Neo4jMemoryClient,
  embeddings: Embeddings,
  cfg: MemoryNeo4jConfig,
  extractionConfig: ExtractionConfig,
  sleepAbortController: AbortController,
  logger: Logger,
): void {
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
        logger.info?.(
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
      logger.info?.(
        `memory-neo4j: cleared bootstrap/refresh flags for session=${key} (session_end)`,
      );
    }
  });

  // Merged before_agent_start: mid-session core-memory refresh + auto-recall.
  //
  // Both concerns are combined into a single handler to avoid the "last writer wins"
  // SDK risk where two separate handlers each return prependContext and only the
  // second one takes effect. Both blocks run independently (guarded by their own
  // config flags) and their context strings are concatenated into one prependContext.
  const refreshThreshold = cfg.coreMemory.refreshAtContextPercent;
  const wantCoreRefresh = cfg.coreMemory.enabled && !!refreshThreshold;
  const wantAutoRecall = cfg.autoRecall;

  logger.debug?.(`memory-neo4j: autoRecall=${cfg.autoRecall}`);

  if (wantCoreRefresh) {
    logger.debug?.(
      `memory-neo4j: registering before_agent_start hook for mid-session core refresh at ${refreshThreshold}%`,
    );
  }
  if (wantAutoRecall) {
    logger.debug?.("memory-neo4j: registering before_agent_start hook for auto-recall");
  }

  if (wantCoreRefresh || wantAutoRecall) {
    api.on("before_agent_start", async (event, ctx) => {
      const parts: string[] = [];

      // --- Branch 1: Mid-session core-memory refresh ---
      // Re-inject core memories when context grows past threshold to counter "lost in the middle".
      if (wantCoreRefresh && event.contextWindowTokens && event.estimatedUsedTokens) {
        const sessionKey = ctx.sessionKey ?? "";
        const agentId = ctx.agentId || "default";
        const usagePercent = (event.estimatedUsedTokens / event.contextWindowTokens) * 100;

        if (usagePercent >= refreshThreshold!) {
          const lastRefreshTokens = midSessionRefreshAt.get(sessionKey) ?? 0;
          const tokensSinceRefresh = event.estimatedUsedTokens - lastRefreshTokens;
          if (tokensSinceRefresh < MIN_TOKENS_SINCE_REFRESH) {
            logger.debug?.(
              `memory-neo4j: skipping mid-session refresh (only ${tokensSinceRefresh} tokens since last refresh)`,
            );
          } else {
            try {
              const t0 = performance.now();
              const coreMemories = await db.listCoreForInjection(agentId);

              if (coreMemories.length > 0) {
                midSessionRefreshAt.set(sessionKey, event.estimatedUsedTokens);
                touchSession(sessionKey);

                const content = coreMemories.map((m) => `- ${m.text}`).join("\n");
                const totalMs = performance.now() - t0;
                logger.info?.(
                  `memory-neo4j: [bench] core-refresh ${totalMs.toFixed(0)}ms at ${usagePercent.toFixed(1)}% context (${coreMemories.length} memories)`,
                );

                parts.push(
                  `<core-memory-refresh>\nReminder of persistent context (you may have seen this earlier, re-stating for recency):\n${content}\n</core-memory-refresh>`,
                );
              }
            } catch (err) {
              logger.warn(`memory-neo4j: mid-session core refresh failed: ${String(err)}`);
            }
          }
        }
      }

      // --- Branch 2: Auto-recall ---
      // Inject semantically relevant memories before the agent starts.
      if (wantAutoRecall) {
        if (!event.prompt || event.prompt.length < 5) {
          // No usable prompt — skip recall but don't block branch 1 result
        } else {
          // Skip auto-recall for voice/realtime sessions where latency is critical.
          // These sessions use short conversational turns that don't benefit from
          // memory injection, and the ~100-300ms embedding+search overhead matters.
          const sessionKey = ctx.sessionKey ?? "";
          if (cfg.autoRecallSkipPattern && cfg.autoRecallSkipPattern.test(sessionKey)) {
            logger.debug?.(
              `memory-neo4j: skipping auto-recall for session ${sessionKey} (matches skipPattern)`,
            );
          } else {
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
                { graphSearchDepth: cfg.graphSearchDepth, logger },
              );
              const tSearch = performance.now();

              // Feature 1: Filter out low-relevance results below min RRF score
              results = results.filter((r) => r.score >= cfg.autoRecallMinScore);

              // Feature 2: (Removed) Core memory dedup was filtering relevant core memories
              // from auto-recall results because they were "already in context" from bootstrap.
              // Problem: by mid-session, bootstrap core memories are buried deep in context
              // ("lost in the middle"), so the model forgets them. Filtering them from auto-recall
              // prevented re-surfacing at the point of relevance. Duplicate injection is harmless —
              // same content appears in both core bootstrap and relevant-memories sections,
              // reinforcing important context with recency.

              // Feature 3: Filter out memories related to completed tasks
              const workspaceDir = ctx.workspaceDir;
              if (workspaceDir) {
                try {
                  const completedTasks = await loadCompletedTaskKeywords(workspaceDir);
                  if (completedTasks.length > 0) {
                    const before = results.length;
                    results = results.filter(
                      (r) => !isRelatedToCompletedTask(r.text, completedTasks),
                    );
                    if (results.length < before) {
                      logger.debug?.(
                        `memory-neo4j: task-filter removed ${before - results.length} memories related to completed tasks`,
                      );
                    }
                  }
                } catch (err) {
                  logger.debug?.(`memory-neo4j: task-filter skipped: ${String(err)}`);
                }
              }

              // Layer 3: Filter out memories linked to completed tasks by taskId
              // This complements Layer 1's keyword-based filter with precise taskId matching
              if (workspaceDir) {
                try {
                  const fs = await import("node:fs/promises");
                  const path = await import("node:path");
                  const tasksPath = path.default.join(workspaceDir, "TASKS.md");
                  const content = await fs.default.readFile(tasksPath, "utf-8");
                  const ledger = parseTaskLedger(content);
                  const completedTaskIds = new Set(ledger.completedTasks.map((t) => t.id));
                  if (completedTaskIds.size > 0) {
                    const before = results.length;
                    results = results.filter((r) => !r.taskId || !completedTaskIds.has(r.taskId));
                    if (results.length < before) {
                      logger.debug?.(
                        `memory-neo4j: taskId-filter removed ${before - results.length} memories linked to completed tasks`,
                      );
                    }
                  }
                } catch {
                  // TASKS.md doesn't exist or can't be read — skip taskId filter
                }
              }

              const totalMs = performance.now() - t0;
              logger.info?.(
                `memory-neo4j: [bench] auto-recall ${totalMs.toFixed(0)}ms total (search=${(tSearch - t0).toFixed(0)}ms), ${results.length} results`,
              );

              if (results.length > 0) {
                const memoryContext = results.map((r) => `- [${r.category}] ${r.text}`).join("\n");

                logger.debug?.(
                  `memory-neo4j: auto-recall memories: ${JSON.stringify(results.map((r) => ({ id: r.id, text: r.text.slice(0, 80), score: r.score, vec: r.signals?.vector.rank || "-", bm25: r.signals?.bm25.rank || "-", graph: r.signals?.graph.rank || "-" })))}`,
                );

                parts.push(
                  `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
                );
              }
            } catch (err) {
              logger.warn(`memory-neo4j: auto-recall failed: ${String(err)}`);
            }
          }
        }
      }

      if (parts.length === 0) {
        return;
      }

      return { prependContext: parts.join("\n\n") };
    });
  }

  // Core memories: inject as virtual MEMORY.md at bootstrap time (scoped by agentId).
  // Only runs on new sessions and after compaction (not every turn).
  logger.debug?.(`memory-neo4j: coreMemory.enabled=${cfg.coreMemory.enabled}`);
  if (cfg.coreMemory.enabled) {
    logger.debug?.("memory-neo4j: registering agent_bootstrap hook for core memories");
    api.on("agent_bootstrap", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;

      // Skip if this session was already bootstrapped (avoid re-loading every turn).
      // The after_compaction hook clears the flag so we re-inject after compaction.
      if (sessionKey && bootstrappedSessions.has(sessionKey)) {
        logger.debug?.(
          `memory-neo4j: skipping core memory injection for already-bootstrapped session=${sessionKey}`,
        );
        return;
      }

      // Log when we're about to inject core memories for a session that wasn't tracked
      // This helps diagnose cases where context might be lost after gateway restarts
      if (sessionKey) {
        logger.debug?.(
          `memory-neo4j: session=${sessionKey} not in bootstrappedSessions (size=${bootstrappedSessions.size}), will check for core memories`,
        );
      }

      try {
        const t0 = performance.now();
        const agentId = ctx.agentId || "default";
        logger.debug?.(
          `memory-neo4j: loading core memories for agent=${agentId} session=${sessionKey ?? "unknown"}`,
        );
        const coreMemories = await db.listCoreForInjection(agentId);
        const tQuery = performance.now();

        if (coreMemories.length === 0) {
          if (sessionKey) {
            bootstrappedSessions.add(sessionKey);
            touchSession(sessionKey);
          }
          logger.info?.(
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
        logger.info?.(
          `memory-neo4j: [bench] core-inject ${totalMs.toFixed(0)}ms (query=${(tQuery - t0).toFixed(0)}ms), ${action} MEMORY.md with ${coreMemories.length} memories`,
        );

        return { files };
      } catch (err) {
        logger.warn(`memory-neo4j: core memory injection failed: ${String(err)}`);
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
  //   The sleep cycle handles entity extraction, categorization, and
  //   decay — mirroring hippocampal replay.
  logger.debug?.(
    `memory-neo4j: autoCapture=${cfg.autoCapture}, extraction.enabled=${extractionConfig.enabled}`,
  );
  if (cfg.autoCapture) {
    logger.debug?.("memory-neo4j: registering agent_end hook for auto-capture");
    api.on("agent_end", (event, ctx) => {
      logger.debug?.(
        `memory-neo4j: agent_end fired (success=${event.success}, messages=${event.messages?.length ?? 0})`,
      );
      if (!event.success || !event.messages || event.messages.length === 0) {
        logger.debug?.("memory-neo4j: skipping - no success or empty messages");
        return;
      }

      // Skip auto-capture for sessions matching the skip pattern (e.g. voice sessions)
      const sessionKey = ctx.sessionKey;
      if (cfg.autoCaptureSkipPattern && sessionKey && cfg.autoCaptureSkipPattern.test(sessionKey)) {
        logger.debug?.(
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
        logger,
        ctx.workspaceDir, // Layer 3: pass workspace dir for task auto-tagging
        cfg.autoCaptureAssistant,
        sleepAbortController.signal,
      );
    });
  }
}
