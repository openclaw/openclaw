import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { AuthStorage } from "./sessions/auth-storage.js";

export function stubCatalogEnv(env: NodeJS.ProcessEnv) {
  for (const key of [
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKER_CATALOG_MARKER",
    "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH",
    "OPENCLAW_WORKER_REF_ONLY_API_KEY",
    "OPENCLAW_WORKER_REF_ONLY_TOKEN",
  ]) {
    vi.stubEnv(key, env[key]);
  }
}

export function catalogAgentFacts(
  input: PreparedModelRuntimeAgentFacts["input"],
  env: NodeJS.ProcessEnv,
  overrides: Partial<PreparedModelRuntimeAgentFacts> = {},
): PreparedModelRuntimeAgentFacts {
  return {
    input,
    env,
    authStore: { version: 1, profiles: {} },
    credentials: {},
    providerIds: [],
    configuredModelRefs: [],
    configuredRuntimeModels: [],
    runtimeCapabilityModels: [],
    configuredGeneratedCatalogPluginIds: [],
    templateAuthStorage: AuthStorage.inMemory({}),
    ...overrides,
  };
}

export function readFixtureLines(root: string, name: string): string[] {
  return fs.readFileSync(path.join(root, name), "utf8").trim().split("\n");
}
