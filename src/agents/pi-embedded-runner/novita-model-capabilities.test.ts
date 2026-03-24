import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock proxy-fetch to always return undefined (no proxy) so tests use globalThis.fetch.
vi.mock("../../infra/net/proxy-fetch.js", () => ({
  resolveProxyFetchFromEnv: () => undefined,
}));

async function withNovitaStateDir(run: (stateDir: string) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-novita-capabilities-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await run(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("novita-model-capabilities", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("parses Novita AI model fields including price conversion and reasoning", async () => {
    await withNovitaStateDir(async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: [
                  {
                    id: "moonshotai/kimi-k2.5",
                    display_name: "Kimi K2.5",
                    input_token_price_per_m: 6000,
                    output_token_price_per_m: 30000,
                    context_size: 262144,
                    max_output_tokens: 262144,
                    features: ["reasoning", "function-calling"],
                    input_modalities: ["text", "image"],
                    status: 1,
                  },
                  {
                    id: "deepseek/deepseek-v3.2",
                    display_name: "DeepSeek V3.2",
                    input_token_price_per_m: 1500,
                    output_token_price_per_m: 5500,
                    context_size: 163840,
                    max_output_tokens: 16384,
                    features: ["function-calling"],
                    input_modalities: ["text"],
                    status: 1,
                  },
                  {
                    id: "inactive/model",
                    display_name: "Inactive",
                    input_token_price_per_m: 0,
                    output_token_price_per_m: 0,
                    context_size: 4096,
                    max_output_tokens: 1024,
                    status: 0,
                  },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            ),
        ),
      );

      const module = await import("./novita-model-capabilities.js");
      await module.loadNovitaModelCapabilities("moonshotai/kimi-k2.5", "test-key");

      // Verify reasoning + multimodal model
      expect(module.getNovitaModelCapabilities("moonshotai/kimi-k2.5")).toMatchObject({
        name: "Kimi K2.5",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 262144,
        maxTokens: 262144,
        cost: {
          // 6000 / 10000 = 0.6
          input: 0.6,
          // 30000 / 10000 = 3
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
        },
      });

      // Verify text-only non-reasoning model with price conversion
      expect(module.getNovitaModelCapabilities("deepseek/deepseek-v3.2")).toMatchObject({
        input: ["text"],
        reasoning: false,
        contextWindow: 163840,
        maxTokens: 16384,
        cost: {
          // 1500 / 10000 = 0.15
          input: 0.15,
          // 5500 / 10000 = 0.55
          output: 0.55,
        },
      });

      // Verify inactive model is filtered out
      expect(module.getNovitaModelCapabilities("inactive/model")).toBeUndefined();

      // Verify auth header was sent
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: "Bearer test-key" },
        }),
      );
    });
  });

  it("does not refetch immediately after an awaited miss for the same model id", async () => {
    await withNovitaStateDir(async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "acme/known-model",
                  display_name: "Known Model",
                  input_token_price_per_m: 0,
                  output_token_price_per_m: 0,
                  context_size: 1234,
                  max_output_tokens: 567,
                  input_modalities: ["text"],
                  status: 1,
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const module = await import("./novita-model-capabilities.js");
      await module.loadNovitaModelCapabilities("acme/missing-model", "test-key");
      expect(module.getNovitaModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second lookup triggers a background refresh
      expect(module.getNovitaModelCapabilities("acme/missing-model")).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
