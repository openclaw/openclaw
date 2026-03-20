import { buildChannelConfigSchema, WhatsAppConfigSchema } from "openclaw/plugin-sdk/whatsapp-core";

export const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppConfigSchema);
