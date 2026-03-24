import { buildChannelConfigSchema, DiscordConfigSchema } from "./runtime-api.js";

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema);
