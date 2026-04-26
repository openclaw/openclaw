import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModelsPreset,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const VERTEX_EXPRESS_PROVIDER_ID = "google-vertex-express";
export const VERTEX_EXPRESS_BASE_URL =
  "https://aiplatform.googleapis.com/v1";

/**
 * Ordered list of Vertex AI Express Mode models shown in the onboarding wizard.
 * First entry is the default selected model.
 */
export const VERTEX_EXPRESS_MODELS = [
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash-Lite (Preview)",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (Preview)",
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (Preview)",
  },
  {
    id: "gemini-3-pro-preview",
    label: "Gemini 3 Pro (Preview)",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
  },
] as const;

export type VertexExpressModelId = (typeof VERTEX_EXPRESS_MODELS)[number]["id"];

/**
 * The default model ref used when writing the agent model primary in config.
 * Format: `<providerId>/<modelId>`.
 */
export const VERTEX_EXPRESS_DEFAULT_MODEL_ID = VERTEX_EXPRESS_MODELS[0].id;
export const VERTEX_EXPRESS_DEFAULT_MODEL_REF = `${VERTEX_EXPRESS_PROVIDER_ID}/${VERTEX_EXPRESS_DEFAULT_MODEL_ID}`;

export function applyVertexExpressModelDefault(
  cfg: OpenClawConfig,
  modelId: string = VERTEX_EXPRESS_DEFAULT_MODEL_ID,
): { next: OpenClawConfig; changed: boolean } {
  const modelRef = `${VERTEX_EXPRESS_PROVIDER_ID}/${modelId}`;
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;
  if (currentPrimary === modelRef) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, modelRef),
    changed: true,
  };
}

export function applyVertexExpressConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = VERTEX_EXPRESS_MODELS.map((m) => ({
    id: m.id,
    name: m.label,
    api: "google-generative-ai" as const,
    baseUrl: VERTEX_EXPRESS_BASE_URL,
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1024 * 1024,
    maxTokens: 8192,
  }));

  return applyProviderConfigWithDefaultModelsPreset(cfg, {
    providerId: VERTEX_EXPRESS_PROVIDER_ID,
    api: "google-generative-ai",
    baseUrl: VERTEX_EXPRESS_BASE_URL,
    defaultModels: models,
  });
}
