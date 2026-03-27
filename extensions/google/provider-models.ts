import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { cloneFirstTemplateModel } from "openclaw/plugin-sdk/provider-models";

const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
// gemini-3-pro-preview was shut down on March 9, 2026; list the active
// gemini-3.1-pro-preview first so it is always tried before the stale entry.
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;
// Include both the new 3.1 preview ID (preferred) and the older 3.0 preview as
// a fallback so forward-compat resolution works regardless of which entry the
// registry carries after a catalog refresh.
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3.1-flash-preview", "gemini-3-flash-preview"] as const;

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
    patch: { reasoning: true },
  });
}

export function isModernGoogleModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("gemini-3");
}
