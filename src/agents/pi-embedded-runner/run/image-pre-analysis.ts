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
export function shouldUseImagePreAnalysis(params: {
  config?: OpenClawConfig;
  modelSupportsImages?: boolean; // kept for compatibility but no longer used
}): boolean {
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
}> {
  const { images, config, agentDir } = params;

  if (images.length === 0) {
    return {
      analysisText: "",
      provider: "",
      model: "",
      imageCount: 0,
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

  const analyses: string[] = [];
  let analyzedCount = 0;
  let successCount = 0;
  let lastProvider = "";
  let lastModel = "";

  // Analyze each image
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!image || image.type !== "image") {
      continue;
    }

    analyzedCount += 1;
    const imageLabel = images.length > 1 ? `Image ${i + 1}` : "Image";

    try {
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
                    data: image.data,
                    mimeType: image.mimeType,
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

      analyses.push(`[${imageLabel} Analysis]\n${result.result.text}`);
      successCount += 1;
      lastProvider = result.result.provider;
      lastModel = result.result.model;

      log.debug(
        `Image pre-analysis: analyzed ${imageLabel} with ${result.result.provider}/${result.result.model}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Image pre-analysis failed for ${imageLabel}: ${errorMsg}`);
      analyses.push(`[${imageLabel}]\n(Image analysis failed.)`);
    }
  }

  const analysisText =
    analyses.length > 0
      ? `\n\n---\n${successCount > 0 ? `The following image analysis was performed by a vision model (${lastProvider}/${lastModel}):\n\n` : ""}${analyses.join("\n\n")}\n---\n`
      : "";

  return {
    analysisText,
    provider: lastProvider,
    model: lastModel,
    imageCount: analyzedCount,
  };
}
