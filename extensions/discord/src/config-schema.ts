import { buildChannelConfigSchema, DiscordConfigSchema } from "openclaw/plugin-sdk/discord-core";

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema);
