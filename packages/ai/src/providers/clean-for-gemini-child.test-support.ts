import assert from "node:assert/strict";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";

let value: unknown = { type: "string", format: "date-time" };
for (let index = 0; index < 2048; index += 1) {
  value = { anyOf: [value, { type: "null" }] };
}
const schema: unknown = JSON.parse(
  JSON.stringify({ type: "object", properties: { value }, required: ["value"] }),
);
const normalized = cleanSchemaForGemini(schema);
const stripped = stripUnsupportedSchemaKeywords(schema, new Set(["format"]));
assert.ok(stripped && typeof stripped === "object" && "properties" in stripped);
const properties = stripped.properties;
assert.ok(properties && typeof properties === "object" && "value" in properties);
let leaf = properties.value;
for (let index = 0; index < 2048; index += 1) {
  assert.ok(leaf && typeof leaf === "object" && "anyOf" in leaf && Array.isArray(leaf.anyOf));
  assert.equal(leaf.anyOf.length, 2);
  assert.deepEqual(leaf.anyOf[1], { type: "null" });
  leaf = leaf.anyOf[0];
}
const circular: { type: string; properties: Record<string, unknown> } = {
  type: "object",
  properties: {},
};
circular.properties.self = circular;
assert.throws(() => cleanSchemaForGemini(circular), TypeError);
assert.throws(() => stripUnsupportedSchemaKeywords(circular, new Set()), TypeError);
process.stdout.write(JSON.stringify({ normalized, leaf }));
