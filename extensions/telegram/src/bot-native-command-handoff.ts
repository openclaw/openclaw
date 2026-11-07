import type { Message } from "grammy/types";
import type { PluginCommandNativeCandidate } from "openclaw/plugin-sdk/plugin-command-runtime";
import {
  getTelegramSpooledReplayDeferredParticipant,
  peekTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";

/** Only the message pipeline creates runtime capabilities; what it does not keep runs natively. */
export type TelegramNativeCommandHandoff = {
  /** Registered Telegram command name; the command body keeps the native executor's spelling. */
  readonly commandName: string;
  readonly candidate: PluginCommandNativeCandidate;
  readonly args: string;
  readonly chatId: number;
  readonly messageId: number;
  /** Set by the pipeline: it dispatches the command, or this message was already dispatched. */
  outcome?: "admitted" | "duplicate";
};

const handoffs = new WeakMap<object, TelegramNativeCommandHandoff>();

export function beginTelegramNativeCommandHandoff(
  update: object,
  handoff: Omit<TelegramNativeCommandHandoff, "outcome">,
): TelegramNativeCommandHandoff {
  const entry: TelegramNativeCommandHandoff = { ...handoff };
  handoffs.set(update, entry);
  return entry;
}

export function endTelegramNativeCommandHandoff(update: object): void {
  handoffs.delete(update);
}

/** Returns the handoff for this update when it carries exactly the offered message. */
export function getTelegramNativeCommandHandoff(
  update: unknown,
  msg: Pick<Message, "message_id" | "chat"> | undefined,
): TelegramNativeCommandHandoff | undefined {
  if (typeof update !== "object" || update === null || !msg) {
    return undefined;
  }
  const handoff = handoffs.get(update);
  return handoff && handoff.messageId === msg.message_id && handoff.chatId === msg.chat.id
    ? handoff
    : undefined;
}

/** Nothing ran the command before this failure, so native answers it; a recorded retry stands. */
export function shouldDeclineTelegramNativeCommandHandoffOnFailure(
  update: unknown,
  msg: Pick<Message, "message_id" | "chat"> | undefined,
): boolean {
  const handoff = getTelegramNativeCommandHandoff(update, msg);
  return (
    handoff !== undefined &&
    handoff.outcome === undefined &&
    peekTelegramMessageProcessingResult()?.kind !== "failed-retryable"
  );
}

/** The reply pipeline captures prompt answers before commands; prompts are this bot's messages. */
export function mayAnswerTelegramConversationPrompt(msg: Message): boolean {
  if (msg.external_reply) {
    return true;
  }
  const reply = msg.reply_to_message;
  if (!reply || reply.forum_topic_created) {
    return false;
  }
  return reply.from?.is_bot !== false;
}

/** Native command names for one message: the offered plugin command counts as native. */
export function withTelegramNativeCommandHandoffName(
  nativeCommandNames: ReadonlyMap<string, string> | undefined,
  handoff: TelegramNativeCommandHandoff | undefined,
): ReadonlyMap<string, string> | undefined {
  if (!handoff) {
    return nativeCommandNames;
  }
  const names = new Map(nativeCommandNames);
  names.set(handoff.commandName, handoff.commandName);
  return names;
}

/** A replay offers the command again, so a pending retry must not run it natively now. */
export async function shouldRunTelegramNativeCommandAfterHandoff(
  handoff: TelegramNativeCommandHandoff,
): Promise<boolean> {
  if (handoff.outcome) {
    return false;
  }
  if (peekTelegramMessageProcessingResult()?.kind === "failed-retryable") {
    return false;
  }
  const participant = getTelegramSpooledReplayDeferredParticipant();
  if (!participant) {
    return true;
  }
  if (!participant.isSettled()) {
    return false;
  }
  return (await participant.task).kind !== "failed-retryable";
}
