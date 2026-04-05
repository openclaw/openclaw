import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("NVIDIA provider", () => {
  it("should include nvidia when NVIDIA_API_KEY is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { NVIDIA_API_KEY: "test-key" },
    });
    expect(providers?.nvidia).toBeDefined();
    expect(providers?.nvidia?.models?.length).toBeGreaterThan(0);
  });

  it("resolves the nvidia api key value from env", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await withEnvAsync({ NVIDIA_API_KEY: "nvidia-test-api-key" }, async () => {
      const auth = await resolveApiKeyForProvider({
        provider: "nvidia",
        agentDir,
      });

      expect(auth.apiKey).toBe("nvidia-test-api-key");
      expect(auth.mode).toBe("api-key");
      expect(auth.source).toContain("NVIDIA_API_KEY");
    });
  });
});

describe("MiniMax implicit provider (#15275)", () => {
  it("should use anthropic-messages API for API-key provider", { timeout: 240_000 }, async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { MINIMAX_API_KEY: "test-key" },
    });
    expect(providers?.minimax).toBeDefined();
    expect(providers?.minimax?.api).toBe("anthropic-messages");
    expect(providers?.minimax?.authHeader).toBe(true);
    expect(providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
  });

  it("should respect MINIMAX_API_HOST env var for CN endpoint (#34487)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: {
        MINIMAX_API_KEY: "test-key",
        MINIMAX_API_HOST: "https://api.minimaxi.com",
      },
    });
    expect(providers?.minimax).toBeDefined();
    expect(providers?.minimax?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(providers?.["minimax-portal"]?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("should set authHeader for minimax portal provider", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "minimax-portal:default": {
              type: "oauth",
              provider: "minimax-portal",
              access: "token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir });
    expect(providers?.["minimax-portal"]?.authHeader).toBe(true);
  });

  it("should include minimax portal provider when MINIMAX_OAUTH_TOKEN is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { MINIMAX_OAUTH_TOKEN: "portal-token" },
    });
    expect(providers?.["minimax-portal"]).toBeDefined();
    expect(providers?.["minimax-portal"]?.authHeader).toBe(true);
  });
});

describe("vLLM provider", () => {
  it("should not include vllm when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.vllm).toBeUndefined();
  });

  it("should include vllm when VLLM_API_KEY is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProvidersForTest({
      agentDir,
      env: { VLLM_API_KEY: "test-key" },
    });

    expect(providers?.vllm).toBeDefined();
    expect(providers?.vllm?.apiKey).toBe("VLLM_API_KEY");
    expect(providers?.vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(providers?.vllm?.api).toBe("openai-completions");

    // Note: discovery is disabled in test environments (VITEST check)
    expect(providers?.vllm?.models).toEqual([]);
  });
});
