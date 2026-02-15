import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPgClient, ensureSchema, upsertConversation, insertMessage } from "./db.js";

const persistPostgresPlugin = {
  id: "persist-postgres",
  name: "Persist (PostgreSQL)",
  kind: "persistence" as const,
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

    async function ensureReady() {
      if (!schemaReady) {
        await ensureSchema(sql);
        schemaReady = true;
        api.logger.info("persist-postgres: schema ready");
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
          const conv = await upsertConversation(sql, {
            sessionKey,
            channel: "gateway",
            lastMessageAt: new Date(),
          });
          await insertMessage(sql, {
            conversationId: conv.id,
            role: "user",
            content: event.prompt,
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
          const conv = await upsertConversation(sql, {
            sessionKey,
            channel: "gateway",
            lastMessageAt: new Date(),
          });
          const content =
            typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant.content);
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
  },
};

export default persistPostgresPlugin;
