import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  syncExternalCliCredentials: vi.fn((_: AuthProfileStore) => false),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: mocks.syncExternalCliCredentials,
}));

let reconcileConfigProviderKeys: typeof import("./auth-profiles.js").reconcileConfigProviderKeys;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;

async function loadFreshModule() {
  vi.resetModules();
  ({ reconcileConfigProviderKeys, clearRuntimeAuthProfileStoreSnapshots } =
    await import("./auth-profiles.js"));
}

function makeTempAgentDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAuthStore(agentDir: string, store: AuthProfileStore): void {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.writeFileSync(authPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function readAuthStore(agentDir: string): AuthProfileStore {
  const authPath = path.join(agentDir, "auth-profiles.json");
  return JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthProfileStore;
}

function buildStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles };
}

describe("reconcileConfigProviderKeys", () => {
  let agentDir: string;

  beforeEach(async () => {
    await loadFreshModule();
    agentDir = makeTempAgentDir("openclaw-reconcile-");
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.clearAllMocks();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("updates stale api_key profile when config apiKey differs", () => {
    const store = buildStore({
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-old-key",
      },
    });
    writeAuthStore(agentDir, store);

    const result = reconcileConfigProviderKeys({
      configProviders: { anthropic: { apiKey: "sk-new-key" } },
      authStores: [{ agentDir, store }],
    });

    expect(result).toBe(true);
    const saved = readAuthStore(agentDir);
    expect(saved.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "sk-new-key",
    });
  });

  it("does not update when config apiKey matches profile key", () => {
    const store = buildStore({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-same-key",
      },
    });
    writeAuthStore(agentDir, store);
    const mtimeBefore = fs.statSync(path.join(agentDir, "auth-profiles.json")).mtimeMs;

    const result = reconcileConfigProviderKeys({
      configProviders: { openai: { apiKey: "sk-same-key" } },
      authStores: [{ agentDir, store }],
    });

    expect(result).toBe(false);
    const mtimeAfter = fs.statSync(path.join(agentDir, "auth-profiles.json")).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("skips profiles backed by keyRef", () => {
    const store = buildStore({
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "resolved-value",
        keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      },
    });
    writeAuthStore(agentDir, store);

    const result = reconcileConfigProviderKeys({
      configProviders: { anthropic: { apiKey: "different-value" } },
      authStores: [{ agentDir, store }],
    });

    expect(result).toBe(false);
  });

  it("skips non-api_key profile types", () => {
    const store = buildStore({
      "github-copilot:default": {
        type: "oauth",
        provider: "github-copilot",
        access: "gho_test",
        refresh: "ghr_test",
        expires: Date.now() + 3600_000,
      },
    });
    writeAuthStore(agentDir, store);

    const result = reconcileConfigProviderKeys({
      configProviders: { "github-copilot": { apiKey: "some-key" } },
      authStores: [{ agentDir, store }],
    });

    expect(result).toBe(false);
  });

  it("skips providers with no apiKey in config", () => {
    const store = buildStore({
      "ollama:default": {
        type: "api_key",
        provider: "ollama",
        key: "old-key",
      },
    });
    writeAuthStore(agentDir, store);

    const result = reconcileConfigProviderKeys({
      configProviders: { ollama: {} },
      authStores: [{ agentDir, store }],
    });

    expect(result).toBe(false);
  });

  it("reconciles across multiple agent dirs", () => {
    const agentDir2 = makeTempAgentDir("openclaw-reconcile-2-");
    try {
      const store1 = buildStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "old-1" },
      });
      const store2 = buildStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "old-2" },
      });
      writeAuthStore(agentDir, store1);
      writeAuthStore(agentDir2, store2);

      const result = reconcileConfigProviderKeys({
        configProviders: { anthropic: { apiKey: "new-key" } },
        authStores: [
          { agentDir, store: store1 },
          { agentDir: agentDir2, store: store2 },
        ],
      });

      expect(result).toBe(true);
      expect(readAuthStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        key: "new-key",
      });
      expect(readAuthStore(agentDir2).profiles["anthropic:default"]).toMatchObject({
        key: "new-key",
      });
    } finally {
      fs.rmSync(agentDir2, { recursive: true, force: true });
    }
  });

  it("preserves usageStats and order when reconciling", () => {
    const store = buildStore({
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "old-key" },
    });
    store.usageStats = {
      "anthropic:default": { lastUsed: 1000, errorCount: 2 },
    };
    store.order = { anthropic: ["anthropic:default"] };
    writeAuthStore(agentDir, store);

    reconcileConfigProviderKeys({
      configProviders: { anthropic: { apiKey: "new-key" } },
      authStores: [{ agentDir, store }],
    });

    const saved = readAuthStore(agentDir);
    expect(saved.profiles["anthropic:default"]).toMatchObject({ key: "new-key" });
    expect(saved.usageStats?.["anthropic:default"]).toMatchObject({
      lastUsed: 1000,
      errorCount: 2,
    });
    expect(saved.order?.anthropic).toEqual(["anthropic:default"]);
  });

  it("returns false for empty configProviders", () => {
    const store = buildStore({
      "openai:default": { type: "api_key", provider: "openai", key: "key" },
    });
    const result = reconcileConfigProviderKeys({
      configProviders: {},
      authStores: [{ agentDir, store }],
    });
    expect(result).toBe(false);
  });

  it("returns false for empty authStores", () => {
    const result = reconcileConfigProviderKeys({
      configProviders: { anthropic: { apiKey: "key" } },
      authStores: [],
    });
    expect(result).toBe(false);
  });
});
