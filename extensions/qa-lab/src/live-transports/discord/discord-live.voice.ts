import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { getCurrentDiscordVoiceState } from "./discord-live.runtime.js";

export async function waitForDiscordVoiceState(
  params: {
    channelId: string;
    guildId: string;
    timeoutMs: number;
    token: string;
  } & ({ expectation: "joined"; sutBotId: string } | { expectation: "left" }),
) {
  const startedAt = Date.now();
  let lastState: Awaited<ReturnType<typeof getCurrentDiscordVoiceState>> = null;
  let lastError: string | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const state = await getCurrentDiscordVoiceState({
        token: params.token,
        guildId: params.guildId,
      });
      lastState = state;
      lastError = undefined;
      if (
        params.expectation === "left"
          ? state?.channel_id !== params.channelId
          : state?.channel_id === params.channelId &&
            (!state.user_id || state.user_id === params.sutBotId)
      ) {
        return state;
      }
    } catch (error) {
      lastError = formatErrorMessage(error);
    }
    await sleep(500);
  }
  if (params.expectation === "left") {
    throw new Error(
      `SUT bot did not leave Discord voice channel ${params.channelId} (last channel=${lastState?.channel_id ?? "none"}${
        lastError ? `; last error: ${lastError}` : ""
      })`,
    );
  }
  const stateDetails = lastState
    ? `last voice state channel=${lastState.channel_id ?? "none"} user=${lastState.user_id ?? "unknown"}`
    : "no current voice state";
  throw new Error(
    `SUT bot did not join Discord voice channel ${params.channelId} (${stateDetails}${
      lastError ? `; last error: ${lastError}` : ""
    })`,
  );
}
