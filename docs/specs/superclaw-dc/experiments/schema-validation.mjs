#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const contractRoot = path.join(root, "contracts", "v0");
const examplesRoot = path.join(contractRoot, "examples");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function validate(schema, value, at = "$") {
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected const ${schema.const}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: expected one of ${schema.enum.join(",")}`);
  }
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === actual || (schema.type === "number" && actual === "integer");
    if (!ok) errors.push(`${at}: expected ${schema.type}, got ${actual}`);
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: missing required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${at}.${key}: additional property`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) errors.push(...validate(childSchema, value[key], `${at}.${key}`));
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validate(schema.items, item, `${at}[${index}]`)));
  }
  return errors;
}

function assertValid(schemaFile, exampleFile) {
  const schema = readJson(path.relative(root, path.join(contractRoot, schemaFile)));
  const example = readJson(path.relative(root, path.join(examplesRoot, exampleFile)));
  const errors = validate(schema, example);
  assert.deepEqual(errors, [], `${exampleFile} should validate`);
}

function assertInvalid(schemaFile, exampleFile, expectedNeedle) {
  const schema = readJson(path.relative(root, path.join(contractRoot, schemaFile)));
  const example = readJson(path.relative(root, path.join(examplesRoot, exampleFile)));
  const errors = validate(schema, example);
  assert.ok(
    errors.some((error) => error.includes(expectedNeedle)),
    `${exampleFile} should fail on ${expectedNeedle}; got ${errors.join("; ")}`,
  );
}

assertValid("request-context.schema.json", "valid-request-context.json");
assertValid("alias-assertion.schema.json", "valid-alias-assertion.json");
assertValid("capability.schema.json", "valid-capability.json");
assertValid("policy-decision-response.schema.json", "valid-policy-decision-response.json");
assertValid("action-receipt.schema.json", "valid-action-receipt.json");
assertValid("memory-write-intent.schema.json", "valid-memory-write-intent.json");

assertInvalid(
  "request-context.schema.json",
  "invalid-request-context-tenant-id.json",
  "customer_tenant_id: missing required",
);
assertInvalid(
  "request-context.schema.json",
  "invalid-request-context-tenant-id.json",
  "identity.tenant_id: additional property",
);

console.log("schema-validation: 8 checks passed");
