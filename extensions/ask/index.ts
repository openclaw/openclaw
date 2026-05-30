import { randomUUID } from "node:crypto";
import type { DiscordInteractiveHandlerContext } from "openclaw/plugin-sdk/discord-interactions";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { classifyAskInput } from "./classifier.js";
import { buildAskDiscordComponents, formatAskCommandFallback } from "./components.js";
import { createAskGrillState, getAskGrillCurrentStep } from "./grill.js";
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
      channels: ["discord"],
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        if (!ctx.senderId) {
          return {
            text: "/ask needs a Discord user id. Please run it from a normal Discord user account.",
          };
        }
        const classified = classifyAskInput(ctx.args);
        const now = Date.now();
        const askId = createAskId();
        const grill =
          classified.mode === "grill" ? createAskGrillState(classified.questionText) : undefined;
        const firstGrillStep = grill ? getAskGrillCurrentStep(grill) : undefined;
        const session: AskSession = {
          askId,
          mode: classified.mode,
          createdAt: now,
          expiresAt: now + ASK_SESSION_TTL_MS,
          requesterUserId: ctx.senderId,
          sourceChannel: ctx.channel,
          sourceChannelId: ctx.channelId,
          sourceThreadId: ctx.messageThreadId,
          threadParentId: ctx.threadParentId,
          accountId: ctx.accountId,
          sessionKey: ctx.sessionKey,
          questionText: firstGrillStep?.question ?? classified.questionText,
          uiType: classified.uiType,
          options: classified.options,
          allowedUsers: [ctx.senderId],
          reusable: false,
          status: "open",
          nextActionPolicy: "log_only",
          requiresSecondGo: true,
          actionScope: "answer_capture_only",
          ...(grill ? { grill } : {}),
        };
        if (session.mode === "grill") {
          await closeActiveGrillSessionsForRequester(stores, session);
        }
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

async function closeActiveGrillSessionsForRequester(
  stores: ReturnType<typeof openAskStores>,
  session: AskSession,
): Promise<void> {
  const entries = await stores.sessions.entries();
  await Promise.all(
    entries
      .map((entry) => entry.value)
      .filter(
        (existing) =>
          existing.mode === "grill" &&
          existing.status === "open" &&
          existing.requesterUserId === session.requesterUserId &&
          existing.accountId === session.accountId &&
          existing.sourceChannelId === session.sourceChannelId &&
          existing.sourceThreadId === session.sourceThreadId,
      )
      .map((existing) =>
        stores.sessions.register(existing.askId, {
          ...existing,
          status: "rejected",
        }),
      ),
  );
}
