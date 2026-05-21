import { randomUUID } from "node:crypto";
import type { DiscordInteractiveHandlerContext } from "openclaw/plugin-sdk/discord-interactions";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyAskInput } from "./classifier.js";
import { buildAskDiscordComponents, formatAskCommandFallback } from "./components.js";
import { createAskInteractiveHandler } from "./interactive-handler.js";
import { ASK_SESSION_TTL_MS, openAskStores } from "./session-store.js";
import type { AskSession } from "./types.js";

export default definePluginEntry({
  id: "ask",
  name: "Ask",
  description: "Minimal HITL question UI for Discord.",
  register(api) {
    const stores = openAskStores(api.runtime);
    const handleAskInteraction = createAskInteractiveHandler(stores);

    api.registerInteractiveHandler({
      channel: "discord",
      namespace: "ask",
      handler: (ctx) => handleAskInteraction(ctx as DiscordInteractiveHandlerContext),
    });

    api.registerCommand({
      name: "ask",
      nativeNames: { default: "ask" },
      description: "Ask the current Discord user with the safest matching interactive UI.",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const classified = classifyAskInput(ctx.args);
        const now = Date.now();
        const askId = createAskId();
        const session: AskSession = {
          askId,
          createdAt: now,
          expiresAt: now + ASK_SESSION_TTL_MS,
          requesterUserId: ctx.senderId,
          sourceChannel: ctx.channel,
          sourceChannelId: ctx.channelId,
          sourceThreadId: ctx.messageThreadId,
          threadParentId: ctx.threadParentId,
          accountId: ctx.accountId,
          sessionKey: ctx.sessionKey,
          questionText: classified.questionText,
          uiType: classified.uiType,
          options: classified.options,
          allowedUsers: ctx.senderId ? [ctx.senderId] : [],
          reusable: false,
          status: "open",
          nextActionPolicy: "log_only",
          requiresSecondGo: true,
          actionScope: "answer_capture_only",
        };
        await stores.sessions.register(askId, session, { ttlMs: ASK_SESSION_TTL_MS });

        return {
          text: formatAskCommandFallback(session),
          channelData: {
            discord: {
              components: buildAskDiscordComponents(session),
            },
          },
        };
      },
    });
  },
});

function createAskId(): string {
  return `ask_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}
