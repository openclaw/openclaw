import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { WorkingMemoryBuffer } from "./buffer.js";
import type { ChatModel } from "./chat.js";
import type { MemoryConfig } from "./config.js";
import type { MemoryDB } from "./database.js";
import type { DreamService } from "./dream.js";
import type { Embeddings } from "./embeddings.js";
import type { GraphDB } from "./graph.js";
import { handleRecall, handleCapture } from "./handlers.js";
import { MemoryQueue } from "./queue.js";
import type { ConversationStack } from "./stack.js";
import { MemoryTracer } from "./tracer.js";

export interface HookDeps {
  db: MemoryDB;
  embeddings: Embeddings;
  chatModel: ChatModel;
  graphDB: GraphDB;
  dreamService: DreamService;
  conversationStack: ConversationStack;
  workingMemory: WorkingMemoryBuffer;
  tracer: MemoryTracer;
  cfg: MemoryConfig;
}

export function registerHooks(api: OpenClawPluginApi, deps: HookDeps): { cleanup: () => void } {
  const { db, dreamService, tracer, cfg } = deps;
  const memoryQueue = new MemoryQueue({
    delayMs: 1500,
    onError: (name, err) =>
      api.logger.warn(
        `memory-hybrid: queue task "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  });

  // ======================================================================
  // Lifecycle: Auto-Recall (before_agent_start)
  // ======================================================================
  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event, ctx) => {
      if (
        ctx?.trigger === "system" ||
        ctx?.trigger === "heartbeat" ||
        ctx?.trigger === "cron" ||
        ctx?.trigger === "memory"
      ) {
        return;
      }
      return handleRecall(event, ctx, api, deps, tracer);
    });
  }

  // ======================================================================
  // Lifecycle: Auto-Capture (agent_end)
  // ======================================================================
  api.on("agent_end", async (event, ctx) => {
    if (
      ctx?.trigger !== "system" &&
      ctx?.trigger !== "heartbeat" &&
      ctx?.trigger !== "cron" &&
      ctx?.trigger !== "memory" &&
      event.messages?.length > 0
    ) {
      dreamService.registerInteraction();
    }

    if (cfg.autoCapture) {
      if (
        ctx?.trigger === "system" ||
        ctx?.trigger === "heartbeat" ||
        ctx?.trigger === "cron" ||
        ctx?.trigger === "memory"
      ) {
        return;
      }

      if (!event.success || !event.messages?.length) {
        return;
      }

      memoryQueue.push("auto-capture", () => handleCapture(event, ctx, api, deps, tracer));
    }
  });

  const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let lastFlushTime = 0;
  const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  let lastPruneTime = 0;

  // Background Periodic Tasks (Flush & Prune)
  const periodicTimer = setInterval(
    async () => {
      const now = Date.now();

      // 1. Periodic Flush of Recall Counts
      if (now - lastFlushTime > FLUSH_INTERVAL_MS) {
        lastFlushTime = now;
        try {
          const flushed = await db.flushRecallCounts();
          if (flushed > 0) {
            api.logger.info(`memory-hybrid: periodically flushed ${flushed} recall count deltas`);
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: periodic flush failed: ${String(err)}`);
        }
      }

      // 2. Periodic Pruning (every 24h)
      if (now - lastPruneTime > PRUNE_INTERVAL_MS) {
        lastPruneTime = now;
        try {
          const deleted = await db.deleteOldUnused(90);
          if (deleted > 0) {
            api.logger.info(`memory-hybrid: auto-pruned ${deleted} unused memories (>90 days)`);
          }
        } catch (err) {
          api.logger.warn(`memory-hybrid: periodic pruning failed: ${String(err)}`);
        }
      }
    },
    5 * 60 * 1000,
  );
  // Allow Node.js to exit even if timer is active
  periodicTimer.unref();

  return {
    cleanup() {
      clearInterval(periodicTimer);
    },
  };
}
