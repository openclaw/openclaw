import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAuthStorePath, resolveProvisionedAuthStorePath } from "./auth-profiles/paths.js";
import { saveAuthProfileStore, saveProvisionedAuthProfileStore } from "./auth-profiles/store.js";
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

  it("writes a canonical provisioned mirror without runtime telemetry", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-provisioned-"));
    try {
      await fs.writeFile(resolveProvisionedAuthStorePath(agentDir), "{}");
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-runtime-value",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
        order: {
          openai: ["openai:default"],
        },
        lastGood: {
          openai: "openai:default",
        },
        usageStats: {
          "openai:default": {
            lastUsed: Date.now(),
          },
        },
      };

      const didSave = saveProvisionedAuthProfileStore(store, agentDir);
      expect(didSave).toBe(true);

      const parsed = JSON.parse(
        await fs.readFile(resolveProvisionedAuthStorePath(agentDir), "utf8"),
      ) as {
        order?: Record<string, string[]>;
        lastGood?: Record<string, string>;
        usageStats?: Record<string, unknown>;
        profiles: Record<string, { key?: string; keyRef?: unknown }>;
      };

      expect(parsed.order).toEqual({ openai: ["openai:default"] });
      expect(parsed.lastGood).toBeUndefined();
      expect(parsed.usageStats).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.key).toBeUndefined();
      expect(parsed.profiles["openai:default"]?.keyRef).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
