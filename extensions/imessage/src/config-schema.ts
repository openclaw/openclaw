import { buildChannelConfigSchema, IMessageConfigSchema } from "../runtime-api.js";

export const IMessageChannelConfigSchema = buildChannelConfigSchema(IMessageConfigSchema);
