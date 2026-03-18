import { buildChannelConfigSchema, TelegramConfigSchema } from "openclaw/plugin-sdk/telegram-core";

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema);
