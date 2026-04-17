import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAuthStatePath, resolveAuthStorePath } from "./auth-profiles/paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

vi.mock("./auth-profiles/external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

describe("saveAuthProfileStore", () => {
  it("strips plaintext when keyRef/tokenRef are present", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-runtime-value",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            token: "gh-runtime-token",
            tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
          },
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-plain",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const parsed = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<
          string,
          { key?: string; keyRef?: unknown; token?: string; tokenRef?: unknown }
        >;
      };

      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });

      expect(parsed.profiles["github-copilot:default"]?.token).toBeUndefined();
      expect(parsed.profiles["github-copilot:default"]?.tokenRef).toEqual({
        source: "env",
        provider: "default",
        id: "GITHUB_TOKEN",
      });

      expect(parsed.profiles["anthropic:default"]?.key).toBe("sk-anthropic-plain");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes the runtime snapshot when a saved store rotates oauth tokens", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-runtime-"));
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: 1,
            profiles: {
              "anthropic:default": {
                type: "oauth",
                provider: "anthropic",
                access: "access-1",
                refresh: "refresh-1",
                expires: 1,
              },
            },
          },
        },
      ]);

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        access: "access-1",
        refresh: "refresh-1",
      });

      const rotatedStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "oauth",
            provider: "anthropic",
            access: "access-2",
            refresh: "refresh-2",
            expires: 2,
          },
        },
      };

      saveAuthProfileStore(rotatedStore, agentDir);

      expect(ensureAuthProfileStore(agentDir).profiles["anthropic:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
      });

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, { access?: string; refresh?: string }>;
      };
      expect(persisted.profiles["anthropic:default"]).toMatchObject({
        access: "access-2",
        refresh: "refresh-2",
      });
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not persist compatibility-only external oauth ownership metadata", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-managedby-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: 123,
            managedBy: "codex-cli",
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const persisted = JSON.parse(await fs.readFile(resolveAuthStorePath(agentDir), "utf8")) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      expect(persisted.profiles["openai-codex:default"]).toMatchObject({
        type: "oauth",
        provider: "openai-codex",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
      });
      expect(persisted.profiles["openai-codex:default"]?.managedBy).toBeUndefined();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("writes runtime scheduling state to auth-state.json only", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-state-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-anthropic-plain",
          },
        },
        order: {
          anthropic: ["anthropic:default"],
        },
        lastGood: {
          anthropic: "anthropic:default",
        },
        usageStats: {
          "anthropic:default": {
            lastUsed: 123,
          },
        },
      };

      saveAuthProfileStore(store, agentDir);

      const authProfiles = JSON.parse(
        await fs.readFile(resolveAuthStorePath(agentDir), "utf8"),
      ) as {
        profiles: Record<string, unknown>;
        order?: unknown;
        lastGood?: unknown;
        usageStats?: unknown;
      };
      expect(authProfiles.profiles["anthropic:default"]).toBeDefined();
      expect(authProfiles.order).toBeUndefined();
      expect(authProfiles.lastGood).toBeUndefined();
      expect(authProfiles.usageStats).toBeUndefined();

      const authState = JSON.parse(await fs.readFile(resolveAuthStatePath(agentDir), "utf8")) as {
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, { lastUsed?: number }>;
      };
      expect(authState.order?.anthropic).toEqual(["anthropic:default"]);
      expect(authState.lastGood?.anthropic).toBe("anthropic:default");
      expect(authState.usageStats?.["anthropic:default"]?.lastUsed).toBe(123);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
