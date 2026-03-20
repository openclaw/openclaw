import { buildChannelConfigSchema, SlackConfigSchema } from "./runtime-api.js";

export const SlackChannelConfigSchema = buildChannelConfigSchema(SlackConfigSchema);
