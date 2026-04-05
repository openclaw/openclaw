import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-model-shared";

const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_LITE_PREFIX = "gemini-3.1-flash-lite";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"] as const;
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"] as const;
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"] as const;
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"] as const;
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"] as const;
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;

function cloneFirstGoogleTemplateModel(params: {
  providerId: string;
  templateProviderId?: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  const templateProviderIds = [params.providerId, params.templateProviderId]
    .map((providerId) => providerId?.trim())
    .filter((providerId): providerId is string => Boolean(providerId));

  for (const templateProviderId of new Set(templateProviderIds)) {
    const model = cloneFirstTemplateModel({
      providerId: templateProviderId,
      modelId: params.modelId,
      templateIds: params.templateIds,
      ctx: params.ctx,
      patch: {
        ...params.patch,
        provider: params.providerId,
      },
    });
    if (model) {
      return model;
    }
  }

  return undefined;
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  templateProviderId?: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = params.ctx.modelId.trim();
  const lower = trimmed.toLowerCase();

  let templateIds: readonly string[];
  if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) {
    templateIds = GEMINI_2_5_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) {
    templateIds = GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) {
    templateIds = GEMINI_2_5_FLASH_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS;
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
  } else {
    return undefined;
  }

  return cloneFirstGoogleTemplateModel({
    providerId: params.providerId,
    templateProviderId: params.templateProviderId,
    modelId: trimmed,
    templateIds,
    ctx: params.ctx,
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower.startsWith("gemini-2.5") || lower.startsWith("gemini-3");
}
