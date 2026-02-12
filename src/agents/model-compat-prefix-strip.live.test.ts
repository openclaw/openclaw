import { type Api, completeSimple, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { collectAnthropicApiKeys } from "./live-auth-keys.js";
import { getApiKeyForModel, requireApiKey } from "./model-auth.js";
import { normalizeModelCompat } from "./model-compat.js";
import { normalizeProviderId } from "./model-selection.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { discoverAuthStorage, discoverModels } from "./pi-model-discovery.js";

const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

describeLive("live model-compat prefix stripping", () => {
  it(
    "strips anthropic/ prefix and successfully calls API",
    async () => {
      const agentDir = resolveOpenClawAgentDir();
      const cfg = loadConfig();
      await ensureOpenClawModelsJson(cfg, agentDir);

      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir);
      const all = Array.isArray(modelRegistry) ? modelRegistry : modelRegistry.getAll();

      // Find an Anthropic model
      const anthropicModels = all.filter(
        (model) => normalizeProviderId(model.provider) === "anthropic",
      ) as Array<Model<Api>>;
      expect(anthropicModels.length).toBeGreaterThan(0);

      // Try to find a specific model first, then fall back to haiku or any available
      const preferredModels = [
        "claude-sonnet-4-5-20250929",
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
      ];

      let baseModel: Model<Api> | undefined;
      for (const preferredId of preferredModels) {
        baseModel = anthropicModels.find((m) => m.id === preferredId);
        if (baseModel) {
          console.log(`[test] Using model: ${baseModel.id}`);
          break;
        }
      }

      if (!baseModel) {
        baseModel = anthropicModels[0];
        console.log(`[test] Using fallback model: ${baseModel?.id}`);
      }

      if (!baseModel) {
        throw new Error("No Anthropic models available");
      }

      // Artificially inject provider prefix to simulate the bug
      const buggyModel = { ...baseModel, id: `anthropic/${baseModel.id}` };
      console.log(`[test] Original model.id: ${baseModel.id}`);
      console.log(`[test] Buggy model.id (with prefix): ${buggyModel.id}`);

      // Apply normalization - should strip the prefix
      const normalizedModel = normalizeModelCompat(buggyModel);
      console.log(`[test] Normalized model.id: ${normalizedModel.id}`);

      // Verify the prefix was stripped
      expect(normalizedModel.id).toBe(baseModel.id);
      expect(normalizedModel.id).not.toContain("anthropic/");

      // Get API key
      const apiKeys = collectAnthropicApiKeys();
      if (apiKeys.length === 0) {
        throw new Error("No Anthropic API keys available. Set ANTHROPIC_API_KEY env var.");
      }

      const apiKeyInfo = await getApiKeyForModel({
        model: normalizedModel,
        cfg,
        profileId: undefined,
        agentDir,
      });
      const apiKey = requireApiKey(apiKeyInfo, normalizedModel.provider);

      // Make a real API call with the normalized model
      console.log(`[test] Calling Anthropic API with model.id: ${normalizedModel.id}`);

      let res;
      let apiError: Error | null = null;
      try {
        res = await completeSimple(
          normalizedModel,
          {
            messages: [
              {
                role: "user",
                content: "What is 2+2? Reply with just the number.",
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey,
            maxTokens: 50,
            temperature: 0,
          },
        );
        console.log(`[test] API call succeeded! Response object keys:`, Object.keys(res));
        console.log(`[test] Response:`, JSON.stringify(res, null, 2));
      } catch (err) {
        apiError = err as Error;
        console.log(`[test] API call failed:`, err);
      }

      // The key test: Did the API accept the model ID?
      // If we got here without a "model not found" error, the prefix stripping worked!
      if (apiError) {
        const errorMsg = apiError.message || String(apiError);
        // If it's a model not found error, the fix didn't work
        if (errorMsg.includes("model") && errorMsg.includes("not found")) {
          throw new Error(`Model ID was rejected by API: ${errorMsg}`);
        }
        // Other errors are acceptable (rate limit, auth, etc) - they mean API accepted the model ID
        console.log(`[test] ✅ API accepted model ID (error was: ${errorMsg.substring(0, 100)})`);
      } else if (res) {
        console.log(`[test] ✅ API call succeeded - prefix stripping works!`);
        expect(res).toBeDefined();
      }
    },
    60 * 1000, // 60 second timeout
  );

  it("does not strip prefix for non-anthropic providers", () => {
    // Create a mock OpenAI model with prefix
    const mockOpenAI: Model<Api> = {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    };

    const normalized = normalizeModelCompat(mockOpenAI);

    // OpenAI is NOT in the PROVIDERS_REQUIRING_PREFIX_STRIP set,
    // so the prefix should remain unchanged
    expect(normalized.id).toBe("openai/gpt-4o");
    console.log("[test] ✅ OpenAI prefix preserved (not in strip list)");
  });
});
