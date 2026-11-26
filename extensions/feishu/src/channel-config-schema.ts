import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { FeishuConfigSchema } from "./config-schema.js";

// Doctor uses the same validator; only the channel publishes its JSON Schema projection.
export const FeishuChannelConfigSchema = buildChannelConfigSchema(FeishuConfigSchema, {
  jsonSchemaMode: "input",
});
