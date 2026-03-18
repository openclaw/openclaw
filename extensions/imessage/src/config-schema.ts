import { buildChannelConfigSchema, IMessageConfigSchema } from "openclaw/plugin-sdk/imessage-core";

export const IMessageChannelConfigSchema = buildChannelConfigSchema(IMessageConfigSchema);
