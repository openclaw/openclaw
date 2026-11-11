import { Routes } from "discord-api-types/v10";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { RequestClient } from "../internal/discord.js";
import { resolveDiscordTypingChannelId } from "../pending-auto-thread.js";

const DISCORD_TYPING_START_TIMEOUT_MS = 5_000;

export async function sendTyping(params: {
  rest: RequestClient;
  channelId: string;
  /** Needed only for autoThread "on-first-message", where the thread may not exist yet. */
  accountId?: string;
}) {
  const channelId = params.accountId
    ? resolveDiscordTypingChannelId(params.accountId, params.channelId)
    : params.channelId;
  const result = await raceWithTimeout(
    params.rest.post(Routes.channelTyping(channelId)).then(() => ({
      kind: "sent" as const,
    })),
    DISCORD_TYPING_START_TIMEOUT_MS,
    () => ({ kind: "timeout" as const }),
    { ref: false },
  );
  if (result.kind === "timeout") {
    throw new Error(`discord typing start timed out after ${DISCORD_TYPING_START_TIMEOUT_MS}ms`);
  }
}
