import { RequestClient, type RequestClientOptions } from "./internal/discord.js";

export const DISCORD_REST_TIMEOUT_MS = 15_000;

export function createDiscordRequestClient(
  token: string,
  options?: RequestClientOptions,
): RequestClient {
  return new RequestClient(token, options);
}
