import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { extractTextFromChatContent, stripEnvelope } from "openclaw/plugin-sdk";
import { createPgClient, ensureSchema, upsertConversation, insertMessage } from "./db.js";

/**
 * Derive the messaging channel from a session key.
 * Session keys follow the pattern "agent:{agentId}:{channel}:{userId}".
 * Falls back to "unknown" if the key format is unexpected.
 */
function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  // Standard format: agent:main:telegram:user123 → "telegram"
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}

const persistPostgresPlugin = {
  id: "persist-postgres",
  name: "Persist (PostgreSQL)",
  description: "Persists sessions and messages to PostgreSQL instead of local files",
  register(api: OpenClawPluginApi) {
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    if (!databaseUrl) {
      api.logger.warn(
        "persist-postgres: no databaseUrl in plugin config or DATABASE_URL env, plugin disabled",
      );
      return;
    }

    api.logger.info(`persist-postgres: connecting to PostgreSQL`);
    const sql = createPgClient(databaseUrl);
    let schemaReady = false;
    let initError: unknown = null;

    async function ensureReady() {
      if (schemaReady) {
        return;
      }
      if (initError) {
        throw initError;
      }
      try {
        await sql`SELECT 1`;
        await ensureSchema(sql);
        schemaReady = true;
        api.logger.info("persist-postgres: schema ready");
      } catch (err) {
        initError = err;
        api.logger.error(`persist-postgres: init failed (will not retry): ${err}`);
        throw err;
      }
    }

    // Persist the user prompt when an agent run starts
    api.on(
      "before_agent_start",
      async (event, ctx) => {
        try {
          if (!event.prompt) {
            return {};
          }
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "unknown";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const conv = await upsertConversation(sql, {
            sessionKey,
            channel,
            lastMessageAt: new Date(),
          });
          // Strip channel envelope headers and format as structured JSON
          const rawPrompt = event.prompt;
          const strippedPrompt = stripEnvelope(rawPrompt);
          const hasEnvelope = strippedPrompt !== rawPrompt;
          const userText = strippedPrompt.trim();
          const content = hasEnvelope
            ? JSON.stringify({
                text: userText,
                envelope: rawPrompt.slice(0, rawPrompt.length - userText.length).trim(),
              })
            : userText;
          await insertMessage(sql, {
            conversationId: conv.id,
            role: "user",
            content,
            metadata: hasEnvelope ? { hasEnvelope: true } : undefined,
          });
          api.logger.info(`persist-postgres: persisted user message for session ${sessionKey}`);
        } catch (err) {
          api.logger.error(`persist-postgres: before_agent_start error: ${err}`);
        }
        return {};
      },
      { priority: 50 },
    );

    // Persist the agent's response after the run ends
    api.on(
      "agent_end",
      async (event, ctx) => {
        try {
          type Msg = { role?: string; content?: unknown };
          const messages = (event.messages ?? []) as Msg[];
          const lastAssistant = messages.toReversed().find((m) => m.role === "assistant");
          if (!lastAssistant) {
            return;
          }
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "unknown";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const conv = await upsertConversation(sql, {
            sessionKey,
            channel,
            lastMessageAt: new Date(),
          });
          // Use shared utility for extracting human-readable text from content blocks
          const content = extractTextFromChatContent(lastAssistant.content);
          if (!content) {
            return;
          }
          await insertMessage(sql, {
            conversationId: conv.id,
            role: "assistant",
            content,
          });
          api.logger.info(
            `persist-postgres: persisted assistant message for session ${sessionKey}`,
          );
        } catch (err) {
          api.logger.error(`persist-postgres: agent_end error: ${err}`);
        }
      },
      { priority: 50 },
    );

    // Close connection pool on gateway shutdown
    api.on(
      "gateway_stop",
      async (_event, _ctx) => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("persist-postgres: database connections closed");
        } catch (err) {
          api.logger.error(`persist-postgres: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default persistPostgresPlugin;
