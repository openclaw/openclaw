import { buildChannelConfigSchema, WhatsAppConfigSchema } from "./runtime-api.js";

export const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppConfigSchema);
