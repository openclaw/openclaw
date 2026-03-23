import { buildChannelConfigSchema, TelegramConfigSchema } from "../runtime-api.js";

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema);
