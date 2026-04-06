import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuthStorePath } from "./auth-profiles/paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

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
});
