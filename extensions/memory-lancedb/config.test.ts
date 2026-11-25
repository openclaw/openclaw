import fs from "node:fs";
import path from "node:path";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { afterEach, assert, expect, it, vi } from "vitest";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject; uiHints?: Record<string, unknown> };

function validate(value: unknown) {
  return validateJsonSchemaValue({
    schema: manifest.configSchema,
    cacheKey: "memory-lancedb.manifest",
    value,
  });
}

function configWith(overrides: Record<string, unknown> = {}) {
  return { embedding: { apiKey: "sk-test" }, ...overrides };
}
const parse = memoryConfigSchema.parse.bind(memoryConfigSchema);
function rejects(config: unknown, message: string) {
  expect(() => parse(config)).toThrow(message);
}

afterEach(() => vi.unstubAllEnvs());
it.each([undefined, "~/shared-memory/lancedb"])("resolves dbPath %s at parse time", (dbPath) => {
  const stateDir = path.resolve("/tmp/openclaw-state-after-import");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  expect(parse(configWith({ dbPath })).dbPath).toBe(
    dbPath ?? path.join(stateDir, "memory", "lancedb"),
  );
});

it("accepts provider-backed embedding config without a plugin apiKey", () => {
  const config = { embedding: { provider: "openai" } };
  expect(validate(config).ok).toBe(true);
  expect(parse(config).embedding).toMatchObject({
    apiKey: undefined,
    provider: "openai",
    model: "text-embedding-3-small",
  });
});

it("rejects empty embedding config in the manifest schema and runtime parser", () => {
  const config = { embedding: {} };
  const result = validate(config);
  assert(!result.ok);
  expect(result.errors.map((error) => error.text)).toContain(
    "embedding: must not have fewer than 1 properties",
  );
  rejects(config, "embedding config must include at least one setting");
});

it("allows missing embedding config in the manifest so setup can discover fields", () => {
  expect(validate({}).ok).toBe(true);
  rejects({}, "embedding config required");
});

it("defaults non-finite character budgets and rejects invalid dimensions", () => {
  const parsed = parse(configWith({ captureMaxChars: Number.NaN, recallMaxChars: Infinity }));
  expect(parsed).toMatchObject({ captureMaxChars: 500, recallMaxChars: 1000 });
  expect(validate({ embedding: { apiKey: "sk-test", dimensions: 1024.5 } }).ok).toBe(false);
  for (const dimensions of [Number.NaN, 1024.5]) {
    rejects(
      { embedding: { apiKey: "sk-test", dimensions } },
      "embedding.dimensions must be a positive integer",
    );
  }
});

it("accepts custom trigger literals in the manifest schema and runtime parser", () => {
  const triggers = ["记住", "important project"];
  const config = configWith({ customTriggers: triggers, dreaming: { enabled: true } });
  expect(validate(config).ok).toBe(true);
  const { customTriggers, dreaming } = parse({
    ...config,
    customTriggers: ["  记住  ", triggers[1]],
  });
  expect([customTriggers, dreaming]).toEqual([triggers, { enabled: true }]);
});

it("resolves storage environment references", () => {
  vi.stubEnv("TEST_MEMORY_STORAGE_ACCESS_KEY", "env-access");
  expect(
    parse(
      configWith({
        storageOptions: {
          region: "us-west-2",
          access_key: "${TEST_MEMORY_STORAGE_ACCESS_KEY}",
        },
      }),
    ).storageOptions,
  ).toEqual({ region: "us-west-2", access_key: "env-access" });
});

it.each([
  [{ captureMaxChars: 99 }, "captureMaxChars must be between 100 and 10000"],
  [
    { storageOptions: { secret_key: "${TEST_MEMORY_STORAGE_MISSING}" } },
    "Environment variable TEST_MEMORY_STORAGE_MISSING is not set",
  ],
  [
    { storageOptions: { region: "us-west-2", timeout: 30 } },
    "storageOptions.timeout must be a string",
  ],
  [
    { embedding: { provider: "", model: "text-embedding-3-small" } },
    "embedding.provider must not be empty",
  ],
  [{ dreaming: { enabled: true }, unexpected: true }, "memory config has unknown keys: unexpected"],
  [{ customTriggers: ["记住", ""] }, "customTriggers.1 must not be empty"],
  [{ customTriggers: ["x".repeat(101)] }, "customTriggers.0 must be at most 100 characters"],
  [{ dreaming: true }, "dreaming config must be an object"],
])("rejects invalid config: %j", (overrides, message) => {
  vi.stubEnv("TEST_MEMORY_STORAGE_MISSING", undefined);
  rejects(configWith(overrides), message);
});
