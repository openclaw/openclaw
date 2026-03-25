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
import { ConversationStack } from "./stack.js";
import { registerTools } from "./tools.js";

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

    // 1. Initialize Core Engines
    const db = new MemoryDB(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
      cfg.embedding.outputDimensionality,
    );
    const chatModel = new ChatModel(cfg.chatApiKey, cfg.chatModel, cfg.chatProvider);
    const graphDB = new GraphDB(resolvedDbPath);

    // 2. Initialize State Buffers
    const workingMemory = new WorkingMemoryBuffer(50, 0.7, 3);
    const conversationStack = new ConversationStack(30);

    // 3. Initialize Shared Services
    const dreamService = new DreamService(db, chatModel, embeddings, graphDB, api);

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
    };

    registerTools(api, deps);
    registerCli(api, deps);
    registerHooks(api, deps);

    // 6. Define Plugin Service
    api.registerService({
      id: "memory-hybrid",
      start: () => {
        api.logger.info(`memory-hybrid: started (model: ${cfg.embedding.model})`);
        dreamService.start();
      },
      stop: () => {
        dreamService.stop();
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
