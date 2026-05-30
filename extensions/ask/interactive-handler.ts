import type { DiscordInteractiveHandlerContext } from "openclaw/plugin-sdk/discord-interactions";
import { buildAskDiscordComponents } from "./components.js";
import {
  advanceAskGrillSession,
  formatAskGrillSummary,
  isAskGrillSession,
  sanitizeDiscordDisplayText,
} from "./grill.js";
import { ASK_SESSION_TTL_MS, recordAskFeedback, type AskStores } from "./session-store.js";
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
    const advanced = isAskGrillSession(session)
      ? advanceAskGrillSession(session, answer, now)
      : { session: { ...session, status: "answered" as const, result: answer }, completed: true };
    const answered: AskSession = {
      ...advanced.session,
      interactionMessageId: answer.interactionMessageId,
      expiresAt: isAskGrillSession(advanced.session)
        ? now + ASK_SESSION_TTL_MS
        : advanced.session.expiresAt,
    };
    await stores.sessions.register(askId, answered, { ttlMs: ASK_SESSION_TTL_MS });
    await logFeedback(stores, {
      askId,
      type: "answered",
      actorId: ctx.senderId,
      interactionId: ctx.interactionId,
      interactionMessageId: answer.interactionMessageId,
      createdAt: now,
      detail: isAskGrillSession(session)
        ? `grill_step_recorded:${(answered.grill?.answers.length ?? 0).toString()}`
        : summarizeAnswer(answer),
    });

    if (isAskGrillSession(answered) && !advanced.completed) {
      await ctx.respond.editMessage({
        text: formatGrillProgress(answered),
        components: buildAskDiscordComponents(answered),
      });
      return { handled: true };
    }

    await ctx.respond.clearComponents({
      text: isAskGrillSession(answered)
        ? formatAskGrillSummary(answered)
        : `✅ /ask answered: ${summarizeAnswer(answer)}\n-# 記録のみ完了。次の実行には別GOが必要です。`,
    });
    return { handled: true };
  };
}

function formatGrillProgress(session: AskSession): string {
  const answeredCount = session.grill?.answers.length ?? 0;
  return [
    `✅ /ask grill answer recorded (${answeredCount.toString()})`,
    "-# 次の質問へ進みます。ここまでの回答はstateに保存済みです。",
  ].join("\n");
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
    return fieldSummary ? sanitizeDiscordDisplayText(fieldSummary, 300) : "modal submitted";
  }
  if (answer.values?.length) {
    return sanitizeDiscordDisplayText(answer.values.join(", "), 300);
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
