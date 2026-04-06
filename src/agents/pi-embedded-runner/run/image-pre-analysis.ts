/**
 * Image pre-analysis module.
 *
 * When `agents.defaults.imageModel` is configured, this module analyzes images using the
 * configured imageModel first, then passes the text analysis results to the main model.
 * The main model's image capability is only used as a fallback.
 *
 * This helps models like MiniMax M2.1 or GLM that lack native vision capabilities
 * to still understand image content through a vision-capable model.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../model-auth.js";
import { runWithImageModelFallback } from "../../model-fallback.js";
import { ensureOpenClawModelsJson } from "../../models-config.js";
import { discoverAuthStorage, discoverModels } from "../../pi-model-discovery.js";
import { coerceImageModelConfig } from "../../tools/image-tool.helpers.js";
import { log } from "../logger.js";

const DEFAULT_IMAGE_ANALYSIS_PROMPT =
  "Describe this image in detail. Include all visible text, objects, people, colors, layout, and any other relevant information.";

/**
 * Check if image pre-analysis should be used.
 *
 * Returns true when imageModel is configured (has primary or fallbacks).
 * When imageModel is explicitly configured, it takes priority over the main model's
 * image capabilities. The main model's vision capability serves as a fallback only.
 */
export function shouldUseImagePreAnalysis(params: { config?: OpenClawConfig }): boolean {
  const imageModelConfig = coerceImageModelConfig(params.config);
  const hasImageModel =
    Boolean(imageModelConfig.primary?.trim()) || (imageModelConfig.fallbacks?.length ?? 0) > 0;

  return hasImageModel;
}

/**
 * Analyze images using the configured imageModel.
 *
 * @returns Text description of the images that can be appended to the prompt
 */
export async function analyzeImagesWithImageModel(params: {
  images: ImageContent[];
  config?: OpenClawConfig;
  agentDir: string;
  userPrompt?: string;
}): Promise<{
  analysisText: string;
  provider: string;
  model: string;
  imageCount: number;
  successfulImageCount: number;
}> {
  const { images, config, agentDir } = params;

  if (images.length === 0) {
    return {
      analysisText: "",
      provider: "",
      model: "",
      imageCount: 0,
      successfulImageCount: 0,
    };
  }

  const imageModelConfig = coerceImageModelConfig(config);
  if (!imageModelConfig.primary && (imageModelConfig.fallbacks?.length ?? 0) === 0) {
    throw new Error("No imageModel configured for image pre-analysis");
  }

  await ensureOpenClawModelsJson(config, agentDir);
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir);

  // Build analysis prompt
  const analysisPrompt = params.userPrompt
    ? `User's question about this image: "${params.userPrompt}"\n\nPlease describe the image in detail to help answer the user's question.`
    : DEFAULT_IMAGE_ANALYSIS_PROMPT;

  // Build tasks for all valid images, then run in parallel.
  const tasks: Array<{ index: number; image: ImageContent; label: string }> = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!image || image.type !== "image") {
      continue;
    }
    tasks.push({
      index: i,
      image,
      label: images.length > 1 ? `Image ${i + 1}` : "Image",
    });
  }

  let lastProvider = "";
  let lastModel = "";

  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const result = await runWithImageModelFallback({
        cfg: config,
        run: async (provider, modelId) => {
          const model = modelRegistry.find(provider, modelId);
          if (!model) {
            throw new Error(`Unknown model: ${provider}/${modelId}`);
          }
          if (!model.input?.includes("image")) {
            throw new Error(`Model does not support images: ${provider}/${modelId}`);
          }

          const apiKeyInfo = await getApiKeyForModel({
            model,
            cfg: config,
            agentDir,
          });
          const apiKey = requireApiKey(apiKeyInfo, model.provider);
          authStorage.setRuntimeApiKey(model.provider, apiKey);

          // Import complete dynamically to avoid circular dependencies
          const { complete } = await import("@mariozechner/pi-ai");

          // Build context with image
          const context = {
            messages: [
              {
                role: "user" as const,
                timestamp: Date.now(),
                content: [
                  { type: "text" as const, text: analysisPrompt },
                  {
                    type: "image" as const,
                    data: task.image.data,
                    mimeType: task.image.mimeType,
                  },
                ],
              },
            ],
          };

          const message = await complete(model, context, {
            apiKey,
            maxTokens: 1024,
          });

          // Extract text from response
          let text = "";
          if (message.content) {
            for (const block of message.content) {
              if (block && typeof block === "object" && "type" in block) {
                if (block.type === "text" && "text" in block) {
                  text += block.text;
                }
              }
            }
          }

          if (!text.trim()) {
            throw new Error(`Image model returned no text (${provider}/${modelId})`);
          }

          return { text: text.trim(), provider, model: modelId };
        },
      });
      return { label: task.label, result };
    }),
  );

  // Collect results in original order.
  const analyses: string[] = [];
  const analyzedCount = tasks.length;
  let successCount = 0;

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { label, result } = outcome.value;
      analyses.push(`[${label} Analysis]\n${result.result.text}`);
      successCount += 1;
      lastProvider = result.result.provider;
      lastModel = result.result.model;
      log.debug(
        `Image pre-analysis: analyzed ${label} with ${result.result.provider}/${result.result.model}`,
      );
    } else {
      const errorMsg =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log.warn(`Image pre-analysis failed: ${errorMsg}`);
    }
  }

  const analysisText =
    successCount > 0 && analyses.length > 0
      ? `\n\n---\nThe following image analysis was performed by a vision model (${lastProvider}/${lastModel}):\n\n${analyses.join("\n\n")}\n---\n`
      : "";

  return {
    analysisText,
    provider: lastProvider,
    model: lastModel,
    imageCount: analyzedCount,
    successfulImageCount: successCount,
  };
}
