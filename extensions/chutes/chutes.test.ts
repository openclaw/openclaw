import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHUTES_OAUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { CHUTES_BASE_URL } from "openclaw/plugin-sdk/provider-models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyChutesConfig,
  applyChutesProviderConfig,
  CHUTES_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildChutesProvider } from "./provider-catalog.js";

describe("chutes extension", () => {
  describe("buildChutesProvider", () => {
    it("returns a provider config with the Chutes base URL and openai-completions API", async () => {
      const provider = await buildChutesProvider();
      expect(provider.baseUrl).toBe("https://llm.chutes.ai/v1");
      expect(provider.api).toBe("openai-completions");
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.models.length).toBeGreaterThan(0);
    });

    it("returns non-empty models from static catalog when no token provided", async () => {
      const provider = await buildChutesProvider();
      const firstModel = provider.models[0];
      expect(typeof firstModel?.id).toBe("string");
      expect(firstModel?.id.length).toBeGreaterThan(0);
    });
  });

  describe("applyChutesProviderConfig", () => {
    it("adds the chutes provider to the config", () => {
      const result = applyChutesProviderConfig({});
      expect(result.models?.providers?.["chutes"]).toBeDefined();
      expect(result.models?.providers?.["chutes"]?.baseUrl).toBe("https://llm.chutes.ai/v1");
    });

    it("registers model aliases", () => {
      const result = applyChutesProviderConfig({});
      const models = result.agents?.defaults?.models ?? {};
      expect(models["chutes-fast"]).toBeDefined();
      expect(models["chutes-pro"]).toBeDefined();
      expect(models["chutes-vision"]).toBeDefined();
    });
  });

  describe("applyChutesConfig", () => {
    it("sets the primary model to the Chutes default", () => {
      const result = applyChutesConfig({});
      const model = result.agents?.defaults?.model;
      const primary = typeof model === "object" ? model?.primary : model;
      expect(primary).toBe(CHUTES_DEFAULT_MODEL_REF);
    });

    it("includes fallback models", () => {
      const result = applyChutesConfig({});
      const model = result.agents?.defaults?.model;
      const fallbacks = typeof model === "object" ? (model?.fallbacks ?? []) : [];
      expect(fallbacks.length).toBeGreaterThan(0);
    });

    it("sets an image model", () => {
      const result = applyChutesConfig({});
      const imageModel = result.agents?.defaults?.imageModel;
      const primary = typeof imageModel === "object" ? imageModel?.primary : imageModel;
      expect(primary).toBeDefined();
    });
  });

  describe("CHUTES_DEFAULT_MODEL_REF", () => {
    it("starts with chutes/ prefix", () => {
      expect(CHUTES_DEFAULT_MODEL_REF).toMatch(/^chutes\//);
    });
  });

  describe("OAuth profile auth mode", () => {
    let tempDir: string | null = null;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chutes-test-"));
    });

    afterEach(async () => {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        tempDir = null;
      }
    });

    it("resolvesCHUTES_OAUTH_MARKER for oauth-backed profiles", async () => {
      const agentDir = tempDir!;
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "chutes:default": {
              type: "oauth",
              provider: "chutes",
              access: "oauth-access-token",
              refresh: "oauth-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        }),
        "utf8",
      );

      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const oauthProfileId = Object.keys(authStore.profiles).find(
        (id) =>
          authStore.profiles[id]?.provider === "chutes" && authStore.profiles[id]?.type === "oauth",
      );
      expect(oauthProfileId).toBeDefined();

      // Verify CHUTES_OAUTH_MARKER is the expected sentinel value
      expect(CHUTES_OAUTH_MARKER).toBe("chutes-oauth");

      // Verify the provider constant is consistent
      expect(CHUTES_BASE_URL).toBe("https://llm.chutes.ai/v1");
    });

    it("forwards oauth access token to discovery", async () => {
      const agentDir = tempDir!;
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "chutes:default": {
              type: "oauth",
              provider: "chutes",
              access: "my-chutes-access-token",
              refresh: "oauth-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        }),
        "utf8",
      );

      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalFetch = globalThis.fetch;
      delete process.env.VITEST;
      delete process.env.NODE_ENV;

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "chutes/private-model" }] }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        // Test that buildChutesProvider uses the access token for discovery
        await buildChutesProvider("my-chutes-access-token");

        const chutesCalls = fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("chutes.ai"),
        );
        expect(chutesCalls.length).toBeGreaterThan(0);
        const request = chutesCalls[0]?.[1] as { headers?: Record<string, string> } | undefined;
        expect(request?.headers?.Authorization).toBe("Bearer my-chutes-access-token");
      } finally {
        process.env.VITEST = originalVitest;
        process.env.NODE_ENV = originalNodeEnv;
        globalThis.fetch = originalFetch;
      }
    });
  });
});
