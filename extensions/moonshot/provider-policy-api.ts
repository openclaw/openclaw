// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

const MODELS = manifest.modelCatalog.providers.moonshot.models;
// Rows that cannot turn thinking off own their profile (compat.defaultThinkingLevel).
const ALWAYS_THINKING_MODEL_IDS = new Set(
  MODELS.filter((row) => row.compat.thinkingRequired).map((row) => row.id),
);
// Released readers drop `video` from hosted rows, so native video is read from the bundled row.
const NATIVE_VIDEO_MODEL_IDS = new Set(
  MODELS.filter((row) => row.input.includes("video")).map((row) => row.id),
);

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return [MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL].some(
    (official) => baseUrl === official || baseUrl === `${official}/`,
  );
}

export function isMoonshotK3NativeVideoRoute(route: {
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    route.provider === "moonshot" &&
    NATIVE_VIDEO_MODEL_IDS.has(route.modelId ?? "") &&
    route.api === "openai-completions" &&
    isNativeMoonshotBaseUrl(route.baseUrl)
  );
}

export function isMoonshotAlwaysThinkingModelId(modelId: string): boolean {
  return ALWAYS_THINKING_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function resolveThinkingProfile() {
  return {
    levels: [
      { id: "off" as const, label: "off" },
      { id: "low" as const, label: "on" },
    ],
    defaultLevel: "off" as const,
  };
}
