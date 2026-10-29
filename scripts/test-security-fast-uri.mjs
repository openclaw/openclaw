#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";

// Resolve the URI implementation through the actual runtime MCP -> Ajv graph.
const require = createRequire(import.meta.url);
const sdk = createRequire(require.resolve("@modelcontextprotocol/sdk/validation/ajv-provider.js"));
const ajv = createRequire(sdk.resolve("ajv"));
const uri = ajv("fast-uri");

assert.ok(uri.parse("%6Aavascript:alert(1)").error);
assert.ok(uri.parse("http://ev\til.com/p").error);
assert.equal(uri.normalize("../x"), "../x");
assert.equal(
  uri.resolve("https://example.test/a/b", uri.normalize("../x")),
  "https://example.test/x",
);
assert.equal(
  uri.serialize({ path: "javascript:alert(1)" }, { reference: "suffix" }),
  "javascript%3Aalert(1)",
);

// External MCP tool schemas use Ajv through this SDK provider. Valid relative
// references must still compile; malformed scheme identifiers must fail closed.
const provider = new AjvJsonSchemaValidator();
assert.throws(() => provider.getValidator({ $id: "%6Aavascript:alert(1)", type: "object" }));
const validate = provider.getValidator({
  $id: "https://example.test/schemas/tool.json",
  type: "object",
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  $defs: { value: { type: "string" } },
});
assert.equal(validate({ value: "ok" }).valid, true);
assert.equal(validate({ value: 1 }).valid, false);
console.log("fast-uri security and MCP/Ajv compatibility checks passed");
