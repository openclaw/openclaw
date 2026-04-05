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

type GoogleForwardCompatFamily = {
  templateIds: readonly string[];
};

function cloneGoogleTemplateModel(params: {
  providerId: string;
  modelId: string;
  templateIds: readonly string[];
  ctx: ProviderResolveDynamicModelContext;
  patch?: Partial<ProviderRuntimeModel>;
}): ProviderRuntimeModel | undefined {
  return cloneFirstTemplateModel({
    providerId: params.providerId,
    modelId: params.modelId,
    templateIds: params.templateIds,
    ctx: params.ctx,
    patch: {
      ...params.patch,
      provider: params.providerId,
    },
  });
}

export function resolveGoogleGeminiForwardCompatModel(params: {
  providerId: string;
  ctx: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  const trimmed = params.ctx.modelId.trim();
  const lower = trimmed.toLowerCase();

  let family: GoogleForwardCompatFamily;
  if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) {
    family = { templateIds: GEMINI_2_5_PRO_TEMPLATE_IDS };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) {
    family = { templateIds: GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS };
  } else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) {
    family = { templateIds: GEMINI_2_5_FLASH_TEMPLATE_IDS };
  } else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) {
    family = { templateIds: GEMINI_3_1_PRO_TEMPLATE_IDS };
  } else if (lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX)) {
    family = { templateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS };
  } else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) {
    family = { templateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS };
  } else {
    return undefined;
  }

  return cloneGoogleTemplateModel({
    providerId: params.providerId,
    modelId: trimmed,
    templateIds: family.templateIds,
    ctx: params.ctx,
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower.startsWith("gemini-2.5") || lower.startsWith("gemini-3");
}
