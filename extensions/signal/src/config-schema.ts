import { buildChannelConfigSchema, SignalConfigSchema } from "./runtime-api.js";

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema);
