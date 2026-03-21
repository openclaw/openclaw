import { buildChannelConfigSchema, MSTeamsConfigSchema } from "../runtime-api.js";

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema);
