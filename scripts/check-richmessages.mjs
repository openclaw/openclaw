import { TelegramConfigSchema } from "../extensions/telegram/config-api.ts";
const schema = TelegramConfigSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });
console.log("Has richMessages:", "richMessages" in (schema.properties || {}));
const keys = Object.keys(schema.properties || {});
console.log(
  "Keys with rich:",
  keys.filter((k) => k.includes("rich") || k.includes("message")),
);
console.log("Total keys:", keys.length);
console.log("First 10 keys:", keys.slice(0, 10).join(", "));
console.log("Last 10 keys:", keys.slice(-10).join(", "));
