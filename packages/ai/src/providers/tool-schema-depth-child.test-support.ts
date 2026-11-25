import assert from "node:assert/strict";
import { validateToolCall } from "@openclaw/llm-core/validation";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";

let metadata: Record<string, unknown> = { type: "string" };
for (let depth = 0; depth < 5000; depth++) {
  metadata = { type: "object", properties: { next: metadata } };
}
const parameters = normalizeToolParameterSchema({
  type: "object",
  properties: { message: { type: "string" }, metadata },
  required: ["message"],
});
assert.deepEqual(
  validateToolCall([{ name: "deep", description: "Deep tool", parameters }], {
    type: "toolCall",
    name: "deep",
    id: "proof",
    arguments: { message: "ok" },
  }),
  { message: "ok" },
);
process.stdout.write("ok");
