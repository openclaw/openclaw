import type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { asOptionalObjectRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isTelegramReadOnlyControlLaneText } from "./sequential-key.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import {
  isTelegramAmbientSpooledUpdate,
  isTelegramSpooledUpdateSenderAuthorized,
  type TelegramSupersedeAuthContext,
} from "./telegram-ingress-supersede-auth.js";

function* telegramUpdateMessages(update: unknown) {
  const root = asOptionalObjectRecord(update);
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"] as const) {
    const message = asOptionalObjectRecord(root?.[key]);
    if (message) {
      yield message;
    }
  }
}

function isRecognizedTelegramTextCommand(rawText: string, botUsername?: string): boolean {
  return (
    maybeResolveTextAlias(
      normalizeCommandBody(rawText, botUsername ? { botUsername } : undefined),
    ) != null
  );
}

/** Whether a bot_command entity is untargeted or addressed to the known bot identity. */
function isTelegramCommandTargetedAtBot(commandText: string, botUsername?: string): boolean {
  const trimmed = commandText.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const normalized = normalizeCommandBody(
    trimmed,
    botUsername ? { botUsername } : undefined,
  ).trim();
  if (!normalized.startsWith("/") || normalized === "/") {
    return false;
  }
  const preIdentityNormalized = normalizeCommandBody(trimmed, {
    targetedCommandMode: "pre-identity",
  }).trim();
  // Pre-identity mode strips valid @targets. A changed result means the target is
  // unresolved or foreign; equality means untargeted or a known matching target.
  return normalized === preIdentityNormalized;
}

/** True when the update carries a bot_command entity addressed to this bot. */
function updateHasBotCommandEntityForBot(update: unknown, botUsername?: string): boolean {
  for (const message of telegramUpdateMessages(update)) {
    const body = readStringField(message, "text") ?? readStringField(message, "caption") ?? "";
    for (const entities of [message.entities, message.caption_entities]) {
      if (!Array.isArray(entities)) {
        continue;
      }
      for (const entity of entities) {
        const ent = asOptionalObjectRecord(entity);
        // Telegram command handlers only accept entities at the start of a message.
        if (ent?.type !== "bot_command" || ent.offset !== 0 || typeof ent.length !== "number") {
          continue;
        }
        const commandText = body.slice(ent.offset, ent.offset + ent.length);
        if (isTelegramCommandTargetedAtBot(commandText, botUsername)) {
          return true;
        }
      }
    }
  }
  return false;
}

function extractUpdateText(update: unknown): string {
  const root = asOptionalObjectRecord(update);
  for (const msg of telegramUpdateMessages(root)) {
    const text = readStringField(msg, "text") ?? readStringField(msg, "caption");
    if (text !== undefined) {
      return text;
    }
  }
  return readStringField(asOptionalObjectRecord(root?.callback_query), "data") ?? "";
}

/**
 * Drain-level supersede predicate over raw spooled payloads.
 * Authorization is resolved from the new event's numeric sender via the same
 * ingress command gate as the old fence (CommandAuthorized).
 */
export function createShouldSupersedeTelegramSpooledPending(
  auth: Omit<TelegramSupersedeAuthContext, "cfg"> & {
    getConfig: () => TelegramSupersedeAuthContext["cfg"];
  },
) {
  const authorize = async (update: unknown) => {
    const cfg = auth.getConfig();
    const authorized = await isTelegramSpooledUpdateSenderAuthorized(update, {
      accountId: auth.accountId,
      cfg,
    });
    // The drain invokes this after all awaits and before aborting pending work.
    return authorized ? () => auth.getConfig() === cfg : false;
  };
  return async (
    newEvent: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
    pendingEvent: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>,
  ) => {
    const pendingUpdate = pendingEvent.payload.update;
    const newUpdate = newEvent.payload.update;
    // Ambient pending supersede still requires an authorized sender — same as the
    // old fence (post-auth). Unauthorized strangers cannot cancel pre-adoption work.
    if (
      isTelegramAmbientSpooledUpdate(pendingUpdate) &&
      !isTelegramAmbientSpooledUpdate(newUpdate)
    ) {
      return await authorize(newUpdate);
    }
    const text = extractUpdateText(newUpdate);
    if (!text) {
      return false;
    }
    const commandOptions = auth.botUsername ? { botUsername: auth.botUsername } : undefined;
    const abortCommandOptions = auth.botUsername
      ? { botUsername: auth.botUsername }
      : { targetedCommandMode: "pre-identity" as const };
    if (
      isBtwRequestText(text, commandOptions) ||
      isTelegramReadOnlyControlLaneText({
        rawText: text,
        ...(auth.botUsername ? { botUsername: auth.botUsername } : {}),
      })
    ) {
      return false;
    }
    // Abort, static text alias, or native bot_command entity (incl. skill commands)
    // addressed to this bot. Never bare `/` prefixes without a bot_command entity.
    const isAbort = isAbortRequestText(text, abortCommandOptions);
    const isCommand =
      isRecognizedTelegramTextCommand(text, auth.botUsername) ||
      updateHasBotCommandEntityForBot(newUpdate, auth.botUsername);
    if (!isAbort && !isCommand) {
      return false;
    }
    return await authorize(newUpdate);
  };
}
