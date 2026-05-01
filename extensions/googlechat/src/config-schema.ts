import { GoogleChatConfigSchema } from "openclaw/plugin-sdk/bundled-channel-config-schema";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";

export const GoogleChatChannelConfigSchema = buildChannelConfigSchema(GoogleChatConfigSchema);
