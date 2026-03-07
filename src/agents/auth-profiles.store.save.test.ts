import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSealedJsonText } from "../infra/sealed-json-file.js";
import { withEnvAsync } from "../test-utils/env.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { resolveAuthStorePath } from "./auth-profiles/paths.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
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

  it("seals auth-profiles.json when OPENCLAW_PASSPHRASE is set", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-save-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-secret",
          },
        },
      };

      await withEnvAsync({ OPENCLAW_PASSPHRASE: "test-passphrase" }, async () => {
        saveAuthProfileStore(store, agentDir);

        const raw = await fs.readFile(resolveAuthStorePath(agentDir), "utf8");
        expect(isSealedJsonText(raw)).toBe(true);
        expect(raw).not.toContain("sk-secret");

        const loaded = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
        expect(loaded.profiles["openai:default"]).toMatchObject({
          type: "api_key",
          provider: "openai",
          key: "sk-secret",
        });
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
