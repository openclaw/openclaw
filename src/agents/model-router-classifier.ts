/**
 * Router classifier helper for making lightweight LLM calls.
 * Used by the smart model router to classify tasks.
 */

import { completeSimple, getModel, type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { resolveApiKeyForProvider } from "./model-auth.js";
import { logVerbose } from "../globals.js";
import { stripThinkingTagsFromText } from "./pi-embedded-utils.js";

/**
 * Parameters for the classifier call.
 */
export type ClassifierCallParams = {
  provider: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  thinking?: boolean;
};

// Simple in-memory cache for classifier decisions
const decisionCache = new Map<string, string>();

/**
 * Make a simple LLM call for task classification.
 * Uses completeSimple for fast, low-latency responses.
 */
export async function callTaskClassifier(
  params: ClassifierCallParams,
  cfg?: OpenClawConfig,
  agentDir?: string,
): Promise<string> {
  const { provider, model, prompt, timeoutMs, thinking } = params;

  // Check cache
  const cacheKey = `${provider}:${model}:${thinking}:${prompt}`;
  if (decisionCache.has(cacheKey)) {
    logVerbose(`[RouterClassifier] Cache hit for prompt: ${prompt.slice(0, 50)}...`);
    return decisionCache.get(cacheKey)!;
  }

  const startTime = Date.now();

  // Get API key for the classifier model's provider
  const auth = await resolveApiKeyForProvider({
    provider,
    cfg,
    agentDir,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let modelObj = getModel(provider as any, model);
  if (!modelObj) {
    // Fallback: If pi-ai doesn't know the provider (e.g. custom-openai), construct it manually
    // This supports custom models defined in openclaw.json that aren't in pi-ai's static registry
    if (provider === "custom-openai" || (auth.baseUrl && auth.mode === "api-key")) {
      const providerApi = cfg?.models?.providers?.[provider]?.api || "openai-completions";
      modelObj = {
        id: model,
        provider: "openai", // Alias to openai for pi-ai internal logic
        api: providerApi,
        name: model,
      } as any;
      logVerbose(
        `[RouterClassifier] Constructed fallback model object for ${provider}/${model} (api: ${providerApi})`,
      );
    } else {
      throw new Error(`Failed to get model: ${provider}/${model}`);
    }
  }

  // Force baseUrl on the model object because pi-ai openai-responses only looks at model.baseUrl
  if (auth.baseUrl) {
    (modelObj as any).baseUrl = auth.baseUrl;
  }

  // INTERNAL RETRY LOOP
  let attempts = 0;
  const maxRetries = 3;
  let lastError: unknown;

  while (attempts < maxRetries) {
    attempts++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Use the correct API: completeSimple(model, context, options)
      // Extract options to a variable to allow 'baseUrl' (excess property check relaxation)
      const options = {
        apiKey: auth.apiKey,
        baseUrl: auth.baseUrl,
        maxTokens: 1024, // Removed to avoid 500 errors on some custom providers
        temperature: 0, // Removed to avoid 500 errors
        signal: controller.signal,
        ...(thinking ? { reasoning: "low" as const } : {}),
      };

      const result = await completeSimple(
        modelObj as Model<Api>,
        {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        options,
      );

      // DEBUG: Log the raw result to understand structure
      // logVerbose respects the global verbose flag (-v)
      logVerbose(`[RouterDebug] Result: ${JSON.stringify(result, null, 2)}`);

      // Extract text content from the result (AssistantMessage)
      if (!result.content) {
        lastError = new Error("Empty response from classifier");
        continue; // Retry
      }

      const finishAndCache = (text: string) => {
        clearTimeout(timeoutId);
        const final = stripThinkingTagsFromText(text).trim();
        const duration = Date.now() - startTime;
        logVerbose(`[RouterClassifier] Success (${duration}ms): ${final}`);
        // Metrics: could log structured data here if needed
        decisionCache.set(cacheKey, final);
        return final;
      };

      const content = result.content;
      if (typeof content === "string") {
        return finishAndCache(content);
      }
      // Content is array of ContentPart - extract text
      for (const part of content) {
        if (typeof part === "string") {
          return finishAndCache(part);
        }
        if (part && typeof part === "object" && "type" in part && part.type === "text") {
          return finishAndCache((part as { type: "text"; text: string }).text);
        }
      }

      lastError = new Error("No text part in response");
      // Retry (loop continues)
    } catch (err) {
      logVerbose(`[RouterClassifier] Attempt ${attempts} failed: ${err}`);
      lastError = err;
      // Retry on error
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Fallback if all retries failed
  const duration = Date.now() - startTime;
  logVerbose(`[RouterClassifier] Failed after ${maxRetries} attempts (${duration}ms): ${lastError}`);
  return "";
}

/**
 * Create a classifier function bound to the current config.
 * This is used to inject the classifier into resolveRouterModel.
 */
export function createClassifierFn(
  cfg: OpenClawConfig,
  agentDir?: string,
): (params: ClassifierCallParams) => Promise<string> {
  const routerThinking = cfg.agents?.defaults?.router?.thinking ?? false;
  return async (params: ClassifierCallParams) => {
    // Note: Logging moved inside callTaskClassifier for consistent timing including cache
    return await callTaskClassifier({ ...params, thinking: routerThinking }, cfg, agentDir);
  };
}
