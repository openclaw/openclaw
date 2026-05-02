import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  createTypingCallbacks,
  type TypingCallbacks,
} from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { createDiscordRestClient } from "../client.js";
import type { RequestClient } from "../internal/discord.js";
import { sendTyping } from "./typing.js";

export const DISCORD_REPLY_TYPING_MAX_DURATION_MS = 20 * 60_000;

export type DiscordReplyTypingFeedback = TypingCallbacks & {
  updateChannelId: (channelId: string) => void;
  getChannelId: () => string;
};

export function createDiscordReplyTypingFeedback(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId: string;
  channelId: string;
  rest?: RequestClient;
  log: (message: string) => void;
  maxDurationMs?: number;
}): DiscordReplyTypingFeedback {
  let channelId = params.channelId;
  const rest =
    params.rest ??
    createDiscordRestClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    }).rest;
  const callbacks = createTypingCallbacks({
    start: () => sendTyping({ rest, channelId }),
    onStartError: (err) => {
      logTypingFailure({
        log: params.log,
        channel: "discord",
        target: channelId,
        error: err,
      });
    },
    maxDurationMs: params.maxDurationMs ?? DISCORD_REPLY_TYPING_MAX_DURATION_MS,
  });
  return {
    ...callbacks,
    updateChannelId: (nextChannelId) => {
      const trimmed = nextChannelId.trim();
      if (trimmed) {
        channelId = trimmed;
      }
    },
    getChannelId: () => channelId,
  };
}
