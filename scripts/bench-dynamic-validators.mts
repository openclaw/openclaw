// Run: node --import ./scripts/tsx.mjs scripts/bench-dynamic-validators.mts <jit|aot> [iterations] [warmup] [fixture]
// Compare five interleaved fresh baseline/candidate processes per fixture; the default runs all fixtures.
import type { JsonSchemaType } from "@modelcontextprotocol/client";

type Input = Record<string, unknown>;
type Check = (value: Input) => boolean;
const profile = process.argv[2] ?? "jit";
const iterations = Number(process.argv[3] ?? 20_000);
const warmup = Number(process.argv[4] ?? 5_000);
const fixture = process.argv[5];
const names = ["mcp", "plugin", "llm", "llm-coerce"];
if (profile !== "jit" && profile !== "aot") {
  throw new Error("Expected jit or aot profile");
}
if (
  !Number.isSafeInteger(iterations) ||
  iterations <= 0 ||
  !Number.isSafeInteger(warmup) ||
  warmup < 0
) {
  throw new Error("Iterations must be positive and warmup nonnegative safe integers");
}
if (fixture && !names.includes(fixture)) {
  throw new Error(`Unknown fixture: ${fixture}`);
}
// This proof entry supplies the same build facts as the standalone compiler bootstrap.
Reflect.set(globalThis, "__openclawStandaloneBuildInfo", {
  mode: profile,
  openclaw: { version: "validator-benchmark" },
  bun: { version: "validator-benchmark" },
});
if (profile === "aot") {
  // Match the standalone bootstrap when comparing the previous TypeBox fallback.
  const { Settings } = await import("typebox/system");
  Settings.Set({ useAcceleration: false });
}
function start() {
  return { wall: performance.now(), cpu: process.cpuUsage() };
}
function elapsed(mark: ReturnType<typeof start>) {
  const wallMs = performance.now() - mark.wall;
  const cpu = process.cpuUsage(mark.cpu);
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}
function objectSchema(properties: Record<string, JsonSchemaType>) {
  return {
    type: "object" as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
async function prepare(name: string) {
  let check: Check;
  let accepted: [Input, Input];
  let rejected: [Input, ...Input[]];
  const importing = start();
  let imported: ReturnType<typeof elapsed>;
  let setup: ReturnType<typeof elapsed>;
  if (name === "mcp") {
    const { createMcpJsonSchemaValidator } =
      await import("../src/agents/mcp-json-schema-validator.js");
    imported = elapsed(importing);
    const preparing = start();
    const validate = createMcpJsonSchemaValidator().getValidator({
      ...objectSchema({
        email: { type: "string", format: "email" },
        lines: { type: "array", minItems: 1, items: { $ref: "#/$defs/line" } },
      }),
      $defs: {
        line: objectSchema({
          sku: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
        }),
      },
    });
    check = (value) => validate(value).valid;
    setup = elapsed(preparing);
    const email = "buyer@example.test";
    const line = { sku: "A", quantity: 1 };
    accepted = [
      { email, lines: [line] },
      { email, lines: [line, { sku: "B", quantity: 3 }] },
    ];
    rejected = [
      { email: "invalid", lines: [line] },
      { email, lines: [{ sku: "A", quantity: 0 }] },
      { email, lines: [{ ...line, extra: true }] },
    ];
  } else if (name === "plugin") {
    const { validateJsonSchemaValue } = await import("../src/plugins/schema-validator.js");
    imported = elapsed(importing);
    const preparing = start();
    const schema = objectSchema({
      endpoint: { type: "string", format: "uri" },
      contact: { type: "string", format: "email" },
      attempts: { type: "integer", minimum: 1 },
    });
    check = (value) => validateJsonSchemaValue({ schema, value }).ok;
    setup = elapsed(preparing);
    accepted = [
      { endpoint: "https://example.test/api", contact: "annotation only", attempts: 1 },
      { endpoint: "https://example.test/next", contact: "buyer@example.test", attempts: 2 },
    ];
    rejected = [
      { endpoint: "invalid", contact: "annotation only", attempts: 1 },
      { endpoint: "https://example.test/api", contact: "annotation only", attempts: 0 },
    ];
  } else {
    const { validateToolArguments } = await import("../packages/llm-core/src/validation.js");
    imported = elapsed(importing);
    const preparing = start();
    const tool = {
      name: "read",
      description: "Validator benchmark",
      parameters: {
        ...objectSchema({
          request: objectSchema({
            limit: { $ref: "#/$defs/limit" },
            tags: { type: "array", items: { type: "string" } },
          }),
          active: { type: "boolean" },
        }),
        $defs: { limit: { type: "integer", minimum: 1 } },
      },
    };
    check = (value) => {
      try {
        validateToolArguments(tool, {
          type: "toolCall",
          id: "call",
          name: tool.name,
          arguments: value,
        });
        return true;
      } catch {
        return false;
      }
    };
    setup = elapsed(preparing);
    accepted =
      name === "llm-coerce"
        ? [
            { request: { limit: "2", tags: ["a", "b"] }, active: "true" },
            { request: { limit: "3", tags: ["c"] }, active: "false" },
          ]
        : [
            { request: { limit: 2, tags: ["a", "b"] }, active: true },
            { request: { limit: 3, tags: ["c"] }, active: false },
          ];
    rejected = [
      { request: { limit: 0, tags: ["a"] }, active: true },
      { request: { limit: "invalid", tags: ["a"] }, active: true },
    ];
  }
  return { check, accepted, rejected, imported, setup };
}
const results = [];
for (const name of names.filter((candidate) => !fixture || candidate === fixture)) {
  const { check, accepted, rejected, imported, setup } = await prepare(name);
  const first = start();
  if (!check(accepted[0])) {
    throw new Error(`${name}: positive control failed`);
  }
  const firstValid = elapsed(first);
  const invalid = start();
  if (check(rejected[0])) {
    throw new Error(`${name}: negative control failed`);
  }
  const firstInvalid = elapsed(invalid);
  if (!accepted.every(check) || rejected.some(check)) {
    throw new Error(`${name}: fixture controls failed`);
  }
  let checksum = 0;
  for (let index = 0; index < warmup; index++) {
    checksum += Number(check(index & 1 ? accepted[0] : accepted[1]));
  }
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const mark = start();
    for (let index = 0; index < iterations; index++) {
      checksum += Number(check(index & 1 ? accepted[0] : accepted[1]));
    }
    const timing = elapsed(mark);
    samples.push({
      ...timing,
      cpuNsPerCheck: (timing.cpuMs * 1e6) / iterations,
      wallNsPerCheck: (timing.wallMs * 1e6) / iterations,
    });
  }
  if (checksum !== warmup + 5 * iterations) {
    throw new Error(`${name}: checksum failed`);
  }
  results.push({ name, imported, setup, firstValid, firstInvalid, checksum, samples });
}
console.log(JSON.stringify({ profile, iterations, warmup, results }));
