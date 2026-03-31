import {
  buildChannelConfigSchema,
  TelegramConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { telegramChannelConfigUiHints } from "./config-ui-hints.js";

export const TelegramChannelConfigSchema = buildChannelConfigSchema(TelegramConfigSchema, {
  uiHints: telegramChannelConfigUiHints,
});
