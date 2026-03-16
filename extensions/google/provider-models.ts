import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "../../src/plugins/types.js";

const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;

function cloneFirstTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmedModelId = params.modelId.trim();
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
    const template = params.ctx.modelRegistry.find(
      params.providerId,
      templateId,
    ) as ProviderRuntimeModel | null;
    if (!template) {
      continue;
    }
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      reasoning: true,
    } as ProviderRuntimeModel);
  }
  return undefined;
}

export function resolveGoogle31ForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = params.ctx.modelId.trim();
  const lower = trimmed.toLowerCase();

  let templateIds: readonly string[];
  if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
  } else {
    return undefined;
  }

  return cloneFirstTemplateModel({
    providerId: params.providerId,
    modelId: trimmed,
    templateIds,
    ctx: params.ctx,
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("gemini-3");
}
