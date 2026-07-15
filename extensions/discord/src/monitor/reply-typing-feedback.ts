// Discord plugin module implements reply typing feedback behavior.
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDiscordRestClient } from "../client.js";
import type { RequestClient } from "../internal/discord.js";
import { sendTyping } from "./typing.js";

const DISCORD_REPLY_TYPING_MAX_DURATION_MS = 20 * 60_000;

// Discord can keep long tool-heavy replies alive, but not forever.
// The dispatch restart path gives each accepted run a fresh controller.
export type DiscordReplyTypingFeedback = ReturnType<typeof createTypingCallbacks> & {
  updateChannelId: (channelId: string) => void;
  getChannelId: () => string;
  restartForDispatch: (channelId: string) => void;
};

export function createDiscordReplyTypingFeedback(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId: string;
  channelId: string;
  rest?: RequestClient;
  log: (message: string) => void;
  maxDurationMs?: number;
  keepaliveIntervalMs?: number;
}): DiscordReplyTypingFeedback {
  let channelId = params.channelId;
  const rest =
    params.rest ??
    createDiscordRestClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    }).rest;
  const createCallbacks = () =>
    createTypingCallbacks({
      start: () => sendTyping({ rest, channelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: params.log,
          channel: "discord",
          target: channelId,
          error: err,
        });
      },
      keepaliveIntervalMs: params.keepaliveIntervalMs,
      maxDurationMs: params.maxDurationMs ?? DISCORD_REPLY_TYPING_MAX_DURATION_MS,
    });
  const updateChannelId = (nextChannelId: string) => {
    const trimmed = nextChannelId.trim();
    if (trimmed) {
      channelId = trimmed;
    }
  };
  let callbacks = createCallbacks();
  return {
    // Expose one stable owner while allowing the inner typing controller to
    // rotate at the actual dispatch boundary.
    onReplyStart: () => callbacks.onReplyStart(),
    onIdle: () => callbacks.onIdle?.(),
    onCleanup: () => callbacks.onCleanup?.(),
    updateChannelId,
    restartForDispatch: (nextChannelId) => {
      updateChannelId(nextChannelId);
      // Rotate the prepared controller so dispatch owns a fresh heartbeat.
      callbacks.onCleanup?.();
      callbacks = createCallbacks();
    },
    getChannelId: () => channelId,
  };
}
