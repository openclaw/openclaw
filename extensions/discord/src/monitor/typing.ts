import { Routes } from "discord-api-types/v10";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { RequestClient } from "../internal/discord.js";

const DISCORD_TYPING_START_TIMEOUT_MS = 5_000;

export async function sendTyping(params: { rest: RequestClient; channelId: string }) {
  const result = await raceWithTimeout(
    params.rest.post(Routes.channelTyping(params.channelId)).then(() => ({
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
