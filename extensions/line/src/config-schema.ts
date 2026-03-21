import { buildChannelConfigSchema, LineConfigSchema } from "../runtime-api.js";

export const LineChannelConfigSchema = buildChannelConfigSchema(LineConfigSchema);
