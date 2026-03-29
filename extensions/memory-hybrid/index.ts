/**
 * OpenClaw Memory (Hybrid) Plugin
 *
 * Modular entry point for the Hybrid Memory system.
 * Orchestrates database, graph, dream mode, and lifecycle hooks.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { WorkingMemoryBuffer } from "./buffer.js";
import { ChatModel } from "./chat.js";
import { registerCli } from "./cli.js";
import { memoryConfigSchema } from "./config.js";
import { MemoryDB } from "./database.js";
import { DreamService } from "./dream.js";
import { Embeddings, vectorDimsForModel } from "./embeddings.js";
import { GraphDB } from "./graph.js";
import { registerHooks } from "./hooks.js";
import { ApiRateLimiter } from "./limiter.js";
import { ConversationStack } from "./stack.js";
import { registerTools } from "./tools.js";
import { MemoryTracer } from "./tracer.js";

const memoryPlugin = {
  id: "memory-hybrid",
  name: "Memory (Hybrid)",
  description: "Enhanced long-term memory with Knowledge Graph and Hybrid Scoring.",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    const vectorDim = cfg.embedding.outputDimensionality ?? vectorDimsForModel(cfg.embedding.model);

    // 1. Initialize Tracing & Logging
    const tracer = new MemoryTracer({ logger: api.logger });

    const limiter = new ApiRateLimiter({
      minDelayMs: 2000,
      maxRequestsPerMinute: 15,
    });

    const db = new MemoryDB(resolvedDbPath, vectorDim, tracer, api.logger);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.outputDimensionality,
      limiter,
      api.logger,
    );
    const chatModel = new ChatModel(
      cfg.chatApiKey,
      cfg.chatModel,
      cfg.chatProvider,
      tracer,
      api.logger,
      limiter,
    );
    const graphDB = new GraphDB(resolvedDbPath, tracer, api.logger);

    // 2. Initialize State Buffers
    const workingMemory = new WorkingMemoryBuffer(50, 0.7, 3);
    const conversationStack = new ConversationStack(30);

    const bufferPath = api.resolvePath("working_memory.jsonl");
    workingMemory.load(bufferPath, api.logger).catch((err) => {
      api.logger.warn(`memory-hybrid: load working memory failed: ${String(err)}`);
    });

    // 3. Initialize Shared Services
    const dreamService = new DreamService(api, db, embeddings, graphDB, chatModel, tracer);

    // 4. Load Graph (Background)
    graphDB.load().catch((err) => {
      api.logger.warn(`memory-hybrid: graph load failed: ${String(err)}`);
    });

    // 5. Register Components
    const deps = {
      db,
      embeddings,
      chatModel,
      graphDB,
      cfg,
      workingMemory,
      conversationStack,
      dreamService,
      tracer,
    };

    registerTools(api, deps);
    registerCli(api, deps);
    const hooksHandle = registerHooks(api, deps);

    // 6. Define Plugin Service
    api.registerService({
      id: "memory-hybrid",
      start: () => {
        api.logger.info(`memory-hybrid: started (model: ${cfg.embedding.model})`);
        dreamService.start();
      },
      stop: () => {
        dreamService.stop();
        hooksHandle.cleanup();
        workingMemory.save(bufferPath, api.logger).catch((err) => {
          api.logger.warn(`memory-hybrid: save working memory failed: ${String(err)}`);
        });
        // Flush recall counts before closing to prevent data loss
        db.flushRecallCounts().catch((err) => {
          api.logger.warn(`memory-hybrid: final recall flush failed: ${String(err)}`);
        });
        db.close().catch((err) => {
          api.logger.warn(`memory-hybrid: db close failed: ${String(err)}`);
        });
        api.logger.info("memory-hybrid: stopped");
      },
    });

    api.logger.info(`memory-hybrid: registered (db: ${resolvedDbPath})`);
  },
};

// Re-exports for other modules and tests
export { vectorDimsForModel } from "./embeddings.js";
export { MemoryDB } from "./database.js";
export default memoryPlugin;
