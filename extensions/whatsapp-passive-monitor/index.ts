import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createDebounceManager, type DebounceManager } from "./src/debounce.js";
import { createFileLogger, composeLoggers } from "./src/file-logger.js";
import { AgentRepositoryImpl } from "./src/repository/agent-repository.js";
import {
  MessageRepositoryImpl,
  type MessageRepository,
} from "./src/repository/message-repository.js";
import { OllamaRepositoryImpl } from "./src/repository/ollama-repository.js";
import { SqliteRepositoryImpl } from "./src/repository/sqlite-repository.js";
import { setupDetectors } from "./src/setup-detectors.js";
import { type Logger, type PluginConfig } from "./src/types.js";

// Default configuration values
const DEFAULT_CONFIG: PluginConfig = {
  ollamaUrl: "http://localhost:11434",
  debounceMs: 5000,
  dbPath: "passive/messages.db",
  outputDir: "passive",
  detectMeetings: true,
};

export default function register(api: OpenClawPluginApi) {
  // Merge user-supplied plugin config (from openclaw.plugin.json schema) with defaults
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(api.pluginConfig as Partial<PluginConfig>),
  };

  // Adapt PluginLogger (optional debug?) to our Logger type
  const adaptPluginLogger = (pl: typeof api.logger): Logger => ({
    info: (msg) => pl.info(msg),
    warn: (msg) => pl.warn(msg),
    error: (msg) => pl.error(msg),
  });

  // Compose console + file logger — all activity goes to both
  const logger = composeLoggers(
    adaptPluginLogger(api.logger),
    createFileLogger("/tmp/openclaw/whatsapp-passive-monitor.log"),
  );

  // Resolve DB path relative to openclaw workspace
  const resolvedDbPath = api.resolvePath(`~/.openclaw/workspace/${config.dbPath}`);

  let messageRepo: MessageRepository;
  try {
    const sqliteRepo = new SqliteRepositoryImpl(resolvedDbPath);
    messageRepo = new MessageRepositoryImpl(sqliteRepo);
  } catch (err) {
    logger.error(`whatsapp-passive-monitor: failed to open SQLite: ${String(err)}`);
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
    logger,
  });

  // Debounce fires → run all detectors sequentially
  const onDebouncefire = (conversationId: string) => {
    registry
      .runAll({ conversationId })
      .catch((err) => logger.error(`whatsapp-passive-monitor: registry error: ${String(err)}`));
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

    // Only trigger detection pipeline if enabled — otherwise just store
    if (config.detectMeetings) {
      debounce.touch(ctx.conversationId ?? event.from);
    }

    // Block ALL WhatsApp messages from reaching the main agent
    return { handled: true };
  });
}
