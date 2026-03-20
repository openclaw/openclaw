import { buildChannelConfigSchema, SignalConfigSchema } from "openclaw/plugin-sdk/signal-core";

export const SignalChannelConfigSchema = buildChannelConfigSchema(SignalConfigSchema);
