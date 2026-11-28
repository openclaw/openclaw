import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { FeishuConfigSchema } from "./config-validator.js";

export * from "./config-validator.js";

// The channel and the bundled metadata generator both read this module. Doctor needs only the validator.
export const FeishuChannelConfigSchema = buildChannelConfigSchema(FeishuConfigSchema, {
  jsonSchemaMode: "input",
});
