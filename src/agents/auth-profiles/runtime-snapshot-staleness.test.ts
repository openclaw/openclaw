import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

function createAuthStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: 1, profiles };
}

function getApiKey(store: AuthProfileStore, profileId: string): string | undefined {
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "api_key") {
    return undefined;
  }
  return cred.key;
}

describe("runtime snapshot staleness detection", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("invalidates stale runtime snapshot when auth-profiles.json is modified externally", async () => {
    await withTempHome("runtime-snapshot-staleness-", async (home) => {
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");

      const initialStore = createAuthStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-old-token",
        },
      });

      await fs.writeFile(authPath, JSON.stringify(initialStore, null, 2), "utf8");
      await fs.utimes(authPath, new Date(1000), new Date(1000));

      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: undefined, store: initialStore }]);

      const beforeRefresh = ensureAuthProfileStore();
      expect(getApiKey(beforeRefresh, "openai:default")).toBe("sk-old-token");

      const updatedStore = createAuthStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-fresh-token",
        },
      });

      await fs.writeFile(authPath, JSON.stringify(updatedStore, null, 2), "utf8");
      await fs.utimes(authPath, new Date(2000), new Date(2000));

      const afterExternalWrite = ensureAuthProfileStore();
      expect(getApiKey(afterExternalWrite, "openai:default")).toBe("sk-fresh-token");
    });
  });

  it("preserves valid runtime snapshot when auth-profiles.json is not modified", async () => {
    await withTempHome("runtime-snapshot-valid-", async (home) => {
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");

      const initialStore = createAuthStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-stable-token",
        },
      });

      await fs.writeFile(authPath, JSON.stringify(initialStore, null, 2), "utf8");

      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: undefined, store: initialStore }]);

      const snapshot = ensureAuthProfileStore();
      expect(getApiKey(snapshot, "openai:default")).toBe("sk-stable-token");
    });
  });

  it("handles multi-agent runtime snapshots with per-path staleness", async () => {
    await withTempHome("runtime-snapshot-multi-agent-", async (home) => {
      const mainAgentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const opsAgentDir = path.join(home, ".openclaw", "agents", "ops", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(opsAgentDir, { recursive: true });

      const mainAuthPath = path.join(mainAgentDir, "auth-profiles.json");
      const opsAuthPath = path.join(opsAgentDir, "auth-profiles.json");

      const mainStore = createAuthStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-main",
        },
      });

      const opsStore = createAuthStore({
        "anthropic:ops": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ops",
        },
      });

      await fs.writeFile(mainAuthPath, JSON.stringify(mainStore, null, 2), "utf8");
      await fs.writeFile(opsAuthPath, JSON.stringify(opsStore, null, 2), "utf8");
      await fs.utimes(mainAuthPath, new Date(1000), new Date(1000));
      await fs.utimes(opsAuthPath, new Date(1000), new Date(1000));

      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir: undefined, store: mainStore },
        { agentDir: opsAgentDir, store: opsStore },
      ]);

      expect(getApiKey(ensureAuthProfileStore(), "openai:default")).toBe("sk-main");
      expect(getApiKey(ensureAuthProfileStore(opsAgentDir), "anthropic:ops")).toBe("sk-ops");

      const updatedOpsStore = createAuthStore({
        "anthropic:ops": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ops-updated",
        },
      });
      await fs.writeFile(opsAuthPath, JSON.stringify(updatedOpsStore, null, 2), "utf8");
      await fs.utimes(opsAuthPath, new Date(2000), new Date(2000));

      expect(getApiKey(ensureAuthProfileStore(), "openai:default")).toBe("sk-main");
      expect(getApiKey(ensureAuthProfileStore(opsAgentDir), "anthropic:ops")).toBe(
        "sk-ops-updated",
      );
    });
  });

  it("clears stale mtime keys when agent is removed from runtime snapshots", async () => {
    await withTempHome("runtime-snapshot-clear-stale-", async (home) => {
      const mainAgentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const opsAgentDir = path.join(home, ".openclaw", "agents", "ops", "agent");
      await fs.mkdir(mainAgentDir, { recursive: true });
      await fs.mkdir(opsAgentDir, { recursive: true });

      const mainAuthPath = path.join(mainAgentDir, "auth-profiles.json");
      const opsAuthPath = path.join(opsAgentDir, "auth-profiles.json");

      const mainStore = createAuthStore({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-main" },
      });
      const opsStore = createAuthStore({
        "anthropic:ops": { type: "api_key", provider: "anthropic", key: "sk-ops" },
      });

      await fs.writeFile(mainAuthPath, JSON.stringify(mainStore, null, 2), "utf8");
      await fs.writeFile(opsAuthPath, JSON.stringify(opsStore, null, 2), "utf8");

      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir: undefined, store: mainStore },
        { agentDir: opsAgentDir, store: opsStore },
      ]);

      expect(getApiKey(ensureAuthProfileStore(), "openai:default")).toBe("sk-main");
      expect(getApiKey(ensureAuthProfileStore(opsAgentDir), "anthropic:ops")).toBe("sk-ops");

      const newMainStore = createAuthStore({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-main-v2" },
      });
      await fs.writeFile(mainAuthPath, JSON.stringify(newMainStore, null, 2), "utf8");

      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir: undefined, store: newMainStore },
        // opsAgentDir removed - should not cause false positive staleness
      ]);

      const result = ensureAuthProfileStore();
      expect(getApiKey(result, "openai:default")).toBe("sk-main-v2");
    });
  });

  it("handles non-existent auth-profiles.json gracefully", async () => {
    await withTempHome("runtime-snapshot-no-file-", async (home) => {
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });

      const initialStore = createAuthStore({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-test" },
      });

      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: undefined, store: initialStore }]);

      const result = ensureAuthProfileStore();
      expect(getApiKey(result, "openai:default")).toBe("sk-test");
    });
  });

  it("preserves runtime snapshot after self-induced saveAuthProfileStore", async () => {
    await withTempHome("runtime-snapshot-self-save-", async (home) => {
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");

      const initialStore = createAuthStore({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-original" },
      });

      await fs.writeFile(authPath, JSON.stringify(initialStore, null, 2), "utf8");

      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: undefined, store: initialStore }]);

      const beforeSave = ensureAuthProfileStore();
      expect(getApiKey(beforeSave, "openai:default")).toBe("sk-original");

      const updatedStore = createAuthStore({
        "openai:default": { type: "api_key", provider: "openai", key: "sk-updated" },
        usageStats: { "openai:default": { lastUsedAtMs: Date.now() } },
      });
      saveAuthProfileStore(updatedStore);

      const afterSave = ensureAuthProfileStore();
      expect(getApiKey(afterSave, "openai:default")).toBe("sk-updated");
    });
  });
});
