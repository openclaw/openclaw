import type { DiscordInteractiveHandlerContext } from "openclaw/plugin-sdk/discord-interactions";
import type { AskStores } from "./session-store.js";
import { recordAskFeedback } from "./session-store.js";
import type { AskAnswer, AskFeedbackEvent, AskSession } from "./types.js";

export function createAskInteractiveHandler(stores: AskStores) {
  return async function handleAskInteraction(ctx: DiscordInteractiveHandlerContext) {
    const parsedPayload = parseAskPayload(ctx.interaction.payload);
    const askId = parsedPayload.askId;
    const now = Date.now();
    if (!askId) {
      await logFeedback(stores, {
        askId: "unknown",
        type: "invalid_payload",
        actorId: ctx.senderId,
        interactionId: ctx.interactionId,
        interactionMessageId: ctx.interaction.messageId,
        createdAt: now,
        detail: "empty ask payload",
      });
      await ctx.respond.reply({ text: "This /ask response is invalid.", ephemeral: true });
      return { handled: true };
    }

    const session = await stores.sessions.lookup(askId);
    if (!session) {
      await logFeedback(stores, {
        askId,
        type: "missing_session",
        actorId: ctx.senderId,
        interactionId: ctx.interactionId,
        interactionMessageId: ctx.interaction.messageId,
        createdAt: now,
      });
      await ctx.respond.reply({
        text: "This /ask has expired. Please run /ask again.",
        ephemeral: true,
      });
      return { handled: true };
    }

    const actorAllowed = isActorAllowed(session, ctx.senderId);
    if (!actorAllowed) {
      await logFeedback(stores, {
        askId,
        type: "unauthorized",
        actorId: ctx.senderId,
        interactionId: ctx.interactionId,
        interactionMessageId: ctx.interaction.messageId,
        createdAt: now,
      });
      await ctx.respond.reply({
        text: "You are not allowed to answer this /ask.",
        ephemeral: true,
      });
      return { handled: true };
    }

    if (session.expiresAt <= now) {
      await stores.sessions.register(askId, { ...session, status: "expired" });
      await logFeedback(stores, {
        askId,
        type: "expired",
        actorId: ctx.senderId,
        interactionId: ctx.interactionId,
        interactionMessageId: ctx.interaction.messageId,
        createdAt: now,
      });
      await ctx.respond.reply({
        text: "This /ask has expired. Please run /ask again.",
        ephemeral: true,
      });
      return { handled: true };
    }

    if (session.status === "answered" && !session.reusable) {
      await logFeedback(stores, {
        askId,
        type: "duplicate",
        actorId: ctx.senderId,
        interactionId: ctx.interactionId,
        interactionMessageId: ctx.interaction.messageId,
        createdAt: now,
      });
      await ctx.respond.reply({ text: "This /ask was already answered.", ephemeral: true });
      return { handled: true };
    }

    const answer: AskAnswer = {
      actorId: ctx.senderId,
      interactionId: ctx.interactionId,
      interactionMessageId: ctx.interaction.messageId ?? session.interactionMessageId,
      kind: ctx.interaction.kind,
      values: parsedPayload.buttonValue ? [parsedPayload.buttonValue] : ctx.interaction.values,
      fields: ctx.interaction.fields,
      answeredAt: now,
    };
    const answered: AskSession = {
      ...session,
      status: "answered",
      interactionMessageId: answer.interactionMessageId,
      result: answer,
    };
    await stores.sessions.register(askId, answered);
    await logFeedback(stores, {
      askId,
      type: "answered",
      actorId: ctx.senderId,
      interactionId: ctx.interactionId,
      interactionMessageId: answer.interactionMessageId,
      createdAt: now,
      detail: summarizeAnswer(answer),
    });

    await ctx.respond.clearComponents({
      text: `✅ /ask answered: ${summarizeAnswer(answer)}\n-# 記録のみ完了。次の実行には別GOが必要です。`,
    });
    return { handled: true };
  };
}

function parseAskPayload(payload: string): { askId: string; buttonValue?: string } {
  const trimmed = payload.trim();
  if (!trimmed) {
    return { askId: "" };
  }
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex < 0) {
    return { askId: trimmed };
  }
  return {
    askId: trimmed.slice(0, separatorIndex),
    buttonValue: trimmed.slice(separatorIndex + 1),
  };
}

function isActorAllowed(session: AskSession, actorId: string | undefined): boolean {
  if (session.allowedUsers.includes("*")) {
    return true;
  }
  return Boolean(actorId && session.allowedUsers.includes(actorId));
}

function summarizeAnswer(answer: AskAnswer): string {
  if (answer.kind === "modal") {
    const fieldSummary = answer.fields
      ?.map((field) => `${field.name}: ${field.values.join(", ")}`)
      .join("; ");
    return fieldSummary || "modal submitted";
  }
  if (answer.values?.length) {
    return answer.values.join(", ");
  }
  return answer.kind;
}

async function logFeedback(
  stores: AskStores,
  event: Omit<AskFeedbackEvent, "eventId">,
): Promise<void> {
  await recordAskFeedback(stores, {
    ...event,
    eventId: `${event.askId}:${event.type}:${event.interactionId ?? event.createdAt}`,
  });
}
