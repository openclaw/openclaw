/**
 * Proof script for PR #91714 — Gemini schema cleaning via modelId for non-Google providers.
 *
 * This script imports the real `normalizeToolParameters` from OpenClaw and runs it
 * with a non-Google provider ("jjcc") + a Gemini model ID ("gemini-2.0-flash")
 * to demonstrate that Gemini schema cleaning is applied.
 */

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

// Use tsx loader to handle TypeScript imports
const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic import via tsx-compatible path
const mod = await import("./src/agents/agent-tools.schema.js");
const { normalizeToolParameters } = mod;

const separator = "=".repeat(70);

console.log(separator);
console.log("PR #91714 — Gemini schema cleaning for OpenAI-compat providers");
console.log(separator);
console.log();
console.log("Environment:");
console.log(`  Node.js:   ${process.version}`);
console.log(`  Platform:  ${process.platform} ${process.arch}`);
console.log();

// ─── Test 1: Non-Google provider + Gemini model ID → anyOf flattened ───
console.log(separator);
console.log("TEST 1: anyOf flattening for jjcc + gemini-2.0-flash");
console.log(separator);

const tool1 = {
  name: "cron_schedule",
  label: "Cron Schedule",
  description: "Schedule a cron job",
  parameters: {
    type: "object",
    required: ["action", "amount", "ghost_field"],
    anyOf: [
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["buy"] },
          amount: { type: "number" },
        },
      },
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["sell"] },
          price: { type: "number" },
        },
      },
    ],
  },
  execute: () => {},
};

const result1 = normalizeToolParameters(tool1, {
  modelProvider: "jjcc",
  modelId: "gemini-2.0-flash",
});

const params1 = result1.parameters;
console.log();
console.log(
  "Input:  schema with anyOf (buy/sell branches) + required: [action, amount, ghost_field]",
);
console.log("Provider: jjcc (non-Google), Model: gemini-2.0-flash");
console.log();
console.log("Output parameters:");
console.log(`  anyOf present:        ${params1.anyOf !== undefined}`);
console.log(`  anyOf value:          ${params1.anyOf}`);
console.log(`  properties:           ${JSON.stringify(Object.keys(params1.properties || {}))}`);
console.log(`  required:             ${JSON.stringify(params1.required)}`);
console.log(`  ghost_field in req:   ${(params1.required || []).includes("ghost_field")}`);
console.log();

const test1Pass =
  params1.anyOf === undefined &&
  (params1.required || []).includes("action") &&
  !(params1.required || []).includes("ghost_field") &&
  params1.properties?.action !== undefined &&
  params1.properties?.amount !== undefined &&
  params1.properties?.price !== undefined;

console.log(
  `RESULT: ${test1Pass ? "PASS ✓" : "FAIL ✗"} — anyOf flattened, ghost_field stripped, properties merged`,
);

// ─── Test 2: Unsupported keyword stripping ───
console.log();
console.log(separator);
console.log("TEST 2: Unsupported keyword stripping for jjcc + gemini-2.0-flash");
console.log(separator);

const tool2 = {
  name: "validate_input",
  label: "Validate Input",
  description: "Validate user input",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
      score: { type: "number", minimum: 0, maximum: 10 },
    },
  },
  execute: () => {},
};

const result2 = normalizeToolParameters(tool2, {
  modelProvider: "jjcc",
  modelId: "gemini-2.0-flash",
});

const nameSchema = result2.parameters.properties?.name || {};
const scoreSchema = result2.parameters.properties?.score || {};

console.log();
console.log("Input:  properties.name has minLength:1, maxLength:100");
console.log("        properties.score has minimum:0, maximum:10");
console.log("Provider: jjcc (non-Google), Model: gemini-2.0-flash");
console.log();
console.log("Output name schema:  " + JSON.stringify(nameSchema));
console.log("Output score schema: " + JSON.stringify(scoreSchema));
console.log();

const test2Pass =
  nameSchema.minLength === undefined &&
  nameSchema.maxLength === undefined &&
  nameSchema.type === "string" &&
  scoreSchema.minimum === undefined &&
  scoreSchema.maximum === undefined &&
  scoreSchema.type === "number";

console.log(
  `RESULT: ${test2Pass ? "PASS ✓" : "FAIL ✗"} — minLength/maxLength/minimum/maximum stripped`,
);

// ─── Test 3: Non-Gemini model ID does NOT get Gemini cleaning ───
console.log();
console.log(separator);
console.log("TEST 3: Non-Gemini model ID preserves keywords (jjcc + gpt-4o)");
console.log(separator);

const tool3 = {
  name: "validate_input",
  label: "Validate Input",
  description: "Validate user input",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
  execute: () => {},
};

const result3 = normalizeToolParameters(tool3, {
  modelProvider: "jjcc",
  modelId: "gpt-4o",
});

const nameSchema3 = result3.parameters.properties?.name || {};

console.log();
console.log("Input:  properties.name has minLength:1, maxLength:100");
console.log("Provider: jjcc (non-Google), Model: gpt-4o");
console.log();
console.log("Output name schema: " + JSON.stringify(nameSchema3));
console.log();

const test3Pass = nameSchema3.minLength === 1 && nameSchema3.maxLength === 100;

console.log(
  `RESULT: ${test3Pass ? "PASS ✓" : "FAIL ✗"} — minLength/maxLength preserved for non-Gemini model`,
);

// ─── Summary ───
console.log();
console.log(separator);
const allPass = test1Pass && test2Pass && test3Pass;
console.log(`SUMMARY: ${allPass ? "ALL TESTS PASSED ✓" : "SOME TESTS FAILED ✗"}`);
console.log(separator);

process.exit(allPass ? 0 : 1);
