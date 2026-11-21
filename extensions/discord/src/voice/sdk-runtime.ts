import { createRequire } from "node:module";

type DiscordVoiceSdk = typeof import("@discordjs/voice");

let cachedDiscordVoiceSdk: DiscordVoiceSdk | null = null;

export function loadDiscordVoiceSdk(): DiscordVoiceSdk {
  return (cachedDiscordVoiceSdk ||= createRequire(import.meta.url)(
    "@discordjs/voice",
  ) as DiscordVoiceSdk);
}
