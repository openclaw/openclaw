import type {
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  maybeResolveTextAlias,
  normalizeCommandBody,
} from "openclaw/plugin-sdk/command-auth-native";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import {
  isTelegramAmbientSpooledUpdate,
  isTelegramSpooledUpdateSenderAuthorized,
  type TelegramSupersedeAuthContext,
} from "./telegram-ingress-supersede-auth.js";

function isTelegramSessionResetCommand(rawText: string, botUsername?: string): boolean {
  const alias = maybeResolveTextAlias(
    normalizeCommandBody(rawText, botUsername ? { botUsername } : undefined),
  );
  return alias === "/new" || alias === "/reset";
}

function extractUpdateText(update: unknown): string {
  if (!update || typeof update !== "object") {
    return "";
  }
  const root = update as Record<string, unknown>;
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"] as const) {
    const msg = root[key];
    if (msg && typeof msg === "object") {
      const text = (msg as { text?: unknown; caption?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      const caption = (msg as { caption?: unknown }).caption;
      if (typeof caption === "string") {
        return caption;
      }
    }
  }
  const callback = root.callback_query;
  if (callback && typeof callback === "object") {
    const data = (callback as { data?: unknown }).data;
    if (typeof data === "string") {
      return data;
    }
  }
  return "";
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
    const abortCommandOptions = auth.botUsername
      ? { botUsername: auth.botUsername }
      : { targetedCommandMode: "pre-identity" as const };
    // Only cancellation and session reset commands discard accepted input.
    // Settings, skills, and other native commands must retain their place after it;
    // a bot_command entity identifies a command, not permission to cancel a turn.
    if (
      !isAbortRequestText(text, abortCommandOptions) &&
      !isTelegramSessionResetCommand(text, auth.botUsername)
    ) {
      return false;
    }
    return await authorize(newUpdate);
  };
}
