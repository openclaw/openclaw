import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMessageDb, type MessageDb } from "./src/db.js";
import { createDebounceManager, type DebounceManager } from "./src/debounce.js";
import { DEFAULT_CONFIG, type PluginConfig } from "./src/types.js";

export default function register(api: OpenClawPluginApi) {
  const raw = (api.pluginConfig ?? {}) as Partial<PluginConfig>;
  const config: PluginConfig = { ...DEFAULT_CONFIG, ...raw };

  // Resolve DB path relative to openclaw workspace
  const resolvedDbPath = api.resolvePath(`~/.openclaw/workspace/${config.dbPath}`);

  let db: MessageDb;
  try {
    db = createMessageDb(resolvedDbPath);
  } catch (err) {
    api.logger.error?.(`whatsapp-passive-monitor: failed to open SQLite: ${String(err)}`);
    return;
  }

  // Debounce callback — placeholder for Part 3/4 (detector pipeline)
  const onDebouncefire = (conversationId: string) => {
    const messages = db.getConversationContext(conversationId, config.contextMessageLimit);
    api.logger.info?.(
      `whatsapp-passive-monitor: debounce fired for ${conversationId}, ${messages.length} messages in context`,
    );
    // Part 3/4 will wire: detector registry → pre-processor → trigger
  };

  const debounce: DebounceManager = createDebounceManager(config.debounceMs, onDebouncefire);

  // ---- message_observed hook ----
  // Captures ALL WhatsApp messages (inbound + phone-typed outbound)
  // before access control. Stores in SQLite, resets debounce,
  // and returns { handled: true } to block agent dispatch.
  api.on("message_observed", async (event, ctx) => {
    if (ctx.channelId !== "whatsapp") return;

    db.insertMessage({
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
