/**
 * Proof: resolveConfigValue `||` → `??` fix — empty env var behavior.
 *
 * Drives the real production AuthStorage, ModelRegistry, and resolveConfigValue
 * through a temporary models.json to prove the full auth-status + runtime path.
 *
 * Usage: node --import tsx proof-config-empty-env.mts
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PROVIDER = "proof-test-provider";
const TEST_ENV_KEY = "OPENCLAW_PROOF_EMPTY_KEY";
let modelsPath: string;
let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) {
      passed++;
      console.log("  ok: %s", description);
    } else {
      failed++;
      console.log("  FAIL: %s", description);
    }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

function writeModelsJson(apiKey: string): string {
  const path = join(tmpdir(), `proof-config-empty-env-${Date.now()}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      providers: {
        [TEST_PROVIDER]: {
          baseUrl: "https://test.example/v1",
          api: "openai-completions",
          apiKey,
          models: [{ id: "proof-model", name: "Proof Model" }],
        },
      },
    }),
  );
  return path;
}

// ── Negative control: prove `||` bug with raw resolver ──
console.log("[case 1] resolveConfigValue: empty env var with || (pre-fix behavior)");
{
  const { resolveConfigValue, resolveConfigValueUncached } = await import(
    "./src/agents/sessions/resolve-config-value.js"
  );

  // Simulate pre-fix `||` behavior
  const buggyResolve = (c: string) => process.env[c] || c;

  process.env[TEST_ENV_KEY] = "";
  const buggy = buggyResolve(TEST_ENV_KEY);
  assert("|| returns key name as value (BUG)", () => buggy === TEST_ENV_KEY);
  console.log("    buggy result: %s (used as API key!)", JSON.stringify(buggy));

  const fixed = resolveConfigValue(TEST_ENV_KEY);
  assert("?? returns empty string (FIXED)", () => fixed === "");
  console.log("    fixed result: %s", JSON.stringify(fixed));

  const fixedUncached = resolveConfigValueUncached(TEST_ENV_KEY);
  assert("?? uncached returns empty string (FIXED)", () => fixedUncached === "");
  delete process.env[TEST_ENV_KEY];
}

// ── Real env: set to actual value ──
console.log("[case 2] resolveConfigValue: env var set to real key");
{
  const { resolveConfigValue } = await import(
    "./src/agents/sessions/resolve-config-value.js"
  );
  process.env[TEST_ENV_KEY] = "sk-real-proof-key-abc123";
  const result = resolveConfigValue(TEST_ENV_KEY);
  assert("real env value returned correctly", () => result === "sk-real-proof-key-abc123");
  delete process.env[TEST_ENV_KEY];
}

// ── Real env: not set (literal fallback) ──
console.log("[case 3] resolveConfigValue: env var not set (literal fallback)");
{
  const { resolveConfigValue } = await import(
    "./src/agents/sessions/resolve-config-value.js"
  );
  const result = resolveConfigValue(TEST_ENV_KEY);
  assert("missing env falls back to literal key name", () => result === TEST_ENV_KEY);
}

// ── Full production path: ModelRegistry with empty env ──
console.log("[case 4] ModelRegistry.getProviderAuthStatus: empty env-backed apiKey");
{
  const { AuthStorage } = await import("./src/agents/sessions/auth-storage.js");
  const { ModelRegistry } = await import("./src/agents/sessions/model-registry.js");

  process.env[TEST_ENV_KEY] = "";
  modelsPath = writeModelsJson(TEST_ENV_KEY);
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

  const status = registry.getProviderAuthStatus(TEST_PROVIDER);
  assert("empty env → configured: false", () => status.configured === false);
  console.log("    status: %s", JSON.stringify(status));

  // Runtime auth returns empty string (not the key name!), provider will reject
  // with "invalid API key" instead of confusing "OPENCLAW_PROOF_EMPTY_KEY" error.
  const apiKey = await registry.getApiKeyAndHeaders(
    registry.find(TEST_PROVIDER, "proof-model")!,
  );
  assert(
    "getApiKeyAndHeaders returns empty apiKey (not key name as apiKey)",
    () => apiKey.ok === true && apiKey.apiKey === "",
  );
  console.log("    apiKey result: ok=%s, apiKey=%s", apiKey.ok, JSON.stringify(apiKey.apiKey));

  delete process.env[TEST_ENV_KEY];
  unlinkSync(modelsPath);
}

// ── Full production path: ModelRegistry with real env ──
console.log("[case 5] ModelRegistry.getProviderAuthStatus: real env-backed apiKey");
{
  const { AuthStorage } = await import("./src/agents/sessions/auth-storage.js");
  const { ModelRegistry } = await import("./src/agents/sessions/model-registry.js");

  process.env[TEST_ENV_KEY] = "sk-real-proof-key-abc123";
  modelsPath = writeModelsJson(TEST_ENV_KEY);
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

  const status = registry.getProviderAuthStatus(TEST_PROVIDER);
  assert(
    "real env → configured: true, source: environment",
    () => status.configured === true && status.source === "environment",
  );
  console.log("    status: %s", JSON.stringify(status));

  delete process.env[TEST_ENV_KEY];
  unlinkSync(modelsPath);
}

// ── Full production path: ModelRegistry with missing env (literal fallback) ──
console.log("[case 6] ModelRegistry.getProviderAuthStatus: missing env (literal fallback)");
{
  const { AuthStorage } = await import("./src/agents/sessions/auth-storage.js");
  const { ModelRegistry } = await import("./src/agents/sessions/model-registry.js");

  modelsPath = writeModelsJson(TEST_ENV_KEY);
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

  const status = registry.getProviderAuthStatus(TEST_PROVIDER);
  assert(
    "missing env → configured: true, source: models_json_key",
    () => status.configured === true && status.source === "models_json_key",
  );
  console.log("    status: %s", JSON.stringify(status));

  unlinkSync(modelsPath);
}

// ── Shell command apiKey ──
console.log("[case 7] ModelRegistry.getProviderAuthStatus: shell command apiKey");
{
  const { AuthStorage } = await import("./src/agents/sessions/auth-storage.js");
  const { ModelRegistry } = await import("./src/agents/sessions/model-registry.js");

  modelsPath = writeModelsJson("!echo sk-test");
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

  const status = registry.getProviderAuthStatus(TEST_PROVIDER);
  assert(
    "shell command → configured: true, source: models_json_command",
    () => status.configured === true && status.source === "models_json_command",
  );
  console.log("    status: %s", JSON.stringify(status));

  unlinkSync(modelsPath);
}

console.log("\n=== Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) process.exit(1);
