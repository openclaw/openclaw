// Quick inline check: does the JSON schema include richMessages?
import { buildChannelConfigSchema } from "./src/channels/plugins/config-schema.js";
import { TelegramConfigSchema } from "./src/config/zod-schema.providers-core.js";

const channelSchema = buildChannelConfigSchema(TelegramConfigSchema);

const jsonSchema = channelSchema.schema;
console.log("=== JSON Schema properties ===");
const props = jsonSchema.properties || {};
const richKeys = Object.keys(props).filter((k) => k.includes("rich") || k.includes("message"));
console.log("Has richMessages:", "richMessages" in props, "||", richKeys.join(", "));
console.log("richMessages type:", JSON.stringify(props.richMessages));
console.log("Total keys:", Object.keys(props).length);
console.log("First 10 keys:", Object.keys(props).slice(0, 10).join(", "));
console.log("Last 10 keys:", Object.keys(props).slice(-10).join(", "));
