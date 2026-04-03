import {
  buildChannelConfigSchema,
  GoogleChatConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
