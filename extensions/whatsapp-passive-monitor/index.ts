import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createDebounceManager, type DebounceManager } from "./src/debounce.js";
import { AgentRepositoryImpl } from "./src/repository/agent-repository.js";
import {
  MessageRepositoryImpl,
  type MessageRepository,
} from "./src/repository/message-repository.js";
import { OllamaRepositoryImpl } from "./src/repository/ollama-repository.js";
import { SqliteRepositoryImpl } from "./src/repository/sqlite-repository.js";
import { setupDetectors } from "./src/setup-detectors.js";
import { type PluginConfig } from "./src/types.js";

// Default configuration values
const DEFAULT_CONFIG: PluginConfig = {
  ollamaUrl: "http://localhost:11434",
  debounceMs: 5000,
  dbPath: "passive/messages.db",
  outputDir: "passive",
};

export default function register(api: OpenClawPluginApi) {
  // TODO: Expose plugin via openclaw plugin in the future
  const config: PluginConfig = { ...DEFAULT_CONFIG };

  // Resolve DB path relative to openclaw workspace
  const resolvedDbPath = api.resolvePath(`~/.openclaw/workspace/${config.dbPath}`);

  let messageRepo: MessageRepository;
  try {
    const sqliteRepo = new SqliteRepositoryImpl(resolvedDbPath);
    messageRepo = new MessageRepositoryImpl(sqliteRepo);
  } catch (err) {
    api.logger.error?.(`whatsapp-passive-monitor: failed to open SQLite: ${String(err)}`);
    return;
  }

  // Single Ollama instance — model is passed per generate() call
  const ollama = new OllamaRepositoryImpl(config.ollamaUrl);
  const agentRepo = new AgentRepositoryImpl(runPluginCommandWithTimeout);

  // Initialize all detectors and register them
  const registry = setupDetectors({
    messageRepo,
    ollama,
    agentRepo,
    logger: api.logger,
  });

  // Debounce fires → run all detectors sequentially
  const onDebouncefire = (conversationId: string) => {
    registry
      .runAll({ conversationId })
      .catch((err) =>
        api.logger.error?.(`whatsapp-passive-monitor: registry error: ${String(err)}`),
      );
  };

  const debounce: DebounceManager = createDebounceManager(config.debounceMs, onDebouncefire);

  // ---- message_observed hook ----
  // Captures ALL WhatsApp messages (inbound + phone-typed outbound)
  // before access control. Stores in SQLite, resets debounce,
  // and returns { handled: true } to block agent dispatch.
  api.on("message_observed", async (event, ctx) => {
    if (ctx.channelId !== "whatsapp") return;

    messageRepo.insertMessage({
      conversation_id: ctx.conversationId ?? event.from,
      sender: event.fromMe ? "me" : event.from,
      sender_name: event.fromMe ? null : ((event.metadata?.pushName as string) ?? null),
      content: event.content,
      timestamp: event.timestamp ?? Date.now(),
      direction: event.fromMe ? "outbound" : "inbound",
      channel_id: "whatsapp",
    });

    // Reset debounce on ALL messages — wait for full conversation to settle
    debounce.touch(ctx.conversationId ?? event.from);

    // Block ALL WhatsApp messages from reaching the main agent
    return { handled: true };
  });
}
