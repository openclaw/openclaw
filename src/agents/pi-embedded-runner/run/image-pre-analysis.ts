import type { Api, Context, Model } from "@mariozechner/pi-ai";
import type { ImageContent } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../model-auth.js";
import { runWithImageModelFallback } from "../../model-fallback.js";
import { ensureOpenClawModelsJson } from "../../models-config.js";
import { discoverAuthStorage, discoverModels } from "../../pi-model-discovery.js";
import { coerceImageAssistantText, type ImageModelConfig } from "../../tools/image-tool.helpers.js";
import { log } from "../logger.js";
import { modelSupportsImages } from "./images.js";

const PRE_ANALYSIS_PROMPT =
  "Describe this image in detail. Include all relevant visual information: text, objects, layout, colors, data, and any other notable elements.";

/**
 * Determines whether image pre-analysis via imageModel should be used instead of native vision.
 *
 * Returns true when:
 * - An imageModel is configured AND
 * - Either `force` is true OR the primary model lacks native vision support
 */
export function shouldUseImagePreAnalysis(params: {
  imageModelConfig: ImageModelConfig;
  primaryModel: { input?: string[] };
}): boolean {
  const hasImageModel = Boolean(params.imageModelConfig.primary?.trim());
  if (!hasImageModel) {
    return false;
  }
  if (params.imageModelConfig.force) {
    return true;
  }
  return !modelSupportsImages(params.primaryModel);
}

/**
 * Analyzes images using the configured imageModel and returns text descriptions
 * to be appended to the prompt (instead of passing raw images to the primary model).
 */
export async function analyzeImagesWithImageModel(params: {
  images: ImageContent[];
  cfg?: OpenClawConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
}): Promise<{
  descriptions: string[];
  provider: string;
  model: string;
}> {
  const { images, cfg, agentDir, imageModelConfig } = params;

  if (images.length === 0) {
    return { descriptions: [], provider: "", model: "" };
  }

  const effectiveCfg: OpenClawConfig | undefined = cfg
    ? {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            imageModel: imageModelConfig,
          },
        },
      }
    : undefined;

  await ensureOpenClawModelsJson(effectiveCfg, agentDir);
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir);

  const descriptions: string[] = [];
  let usedProvider = "";
  let usedModel = "";

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const imageLabel = images.length > 1 ? ` (image ${i + 1}/${images.length})` : "";

    const result = await runWithImageModelFallback({
      cfg: effectiveCfg,
      run: async (provider, modelId) => {
        const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
        if (!model) {
          throw new Error(`Unknown model: ${provider}/${modelId}`);
        }
        if (!model.input?.includes("image")) {
          throw new Error(`Model does not support images: ${provider}/${modelId}`);
        }
        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg: effectiveCfg,
          agentDir,
        });
        const apiKey = requireApiKey(apiKeyInfo, model.provider);
        authStorage.setRuntimeApiKey(model.provider, apiKey);

        const context: Context = {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PRE_ANALYSIS_PROMPT },
                { type: "image", data: image.data, mimeType: image.mimeType },
              ],
              timestamp: Date.now(),
            },
          ],
        };

        const message = await complete(model, context, {
          apiKey,
          maxTokens: 4096,
        });
        const text = coerceImageAssistantText({
          message,
          provider: model.provider,
          model: model.id,
        });
        return { text, provider: model.provider, model: model.id };
      },
    });

    usedProvider = result.result.provider;
    usedModel = result.result.model;
    descriptions.push(result.result.text);

    log.info(`Image pre-analysis${imageLabel}: using ${usedProvider}/${usedModel}`);
  }

  return { descriptions, provider: usedProvider, model: usedModel };
}

/**
 * Formats image analysis descriptions into text to prepend/append to the user prompt.
 */
export function formatImageDescriptionsForPrompt(descriptions: string[]): string {
  if (descriptions.length === 0) {
    return "";
  }
  if (descriptions.length === 1) {
    return `[Image Analysis]\n${descriptions[0]}\n[/Image Analysis]`;
  }
  return descriptions
    .map((desc, i) => `[Image ${i + 1} Analysis]\n${desc}\n[/Image ${i + 1} Analysis]`)
    .join("\n\n");
}
