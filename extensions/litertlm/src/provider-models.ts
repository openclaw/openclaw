const PROVIDER_ID = "litertlm-local";
const PROVIDER_API = "litertlm-local";

export const LITERTLM_MODEL_E2B = "litertlm/gemma4-e2b-edge-gallery";
export const LITERTLM_MODEL_E4B = "litertlm/gemma4-e4b-edge-gallery";

export type LiteRtLmModelPreference = {
  modelId: string;
  preferredMatch: string;
  displayName: string;
  defaultEnabled: boolean;
};

export const LITERTLM_MODEL_PREFERENCES: LiteRtLmModelPreference[] = [
  {
    modelId: LITERTLM_MODEL_E2B,
    preferredMatch: "Gemma_4_E2B_it",
    displayName: "Gemma 4 E2B (LiteRT-LM via Edge Gallery)",
    defaultEnabled: true,
  },
  {
    modelId: LITERTLM_MODEL_E4B,
    preferredMatch: "Gemma_4_E4B_it",
    displayName: "Gemma 4 E4B (LiteRT-LM via Edge Gallery)",
    defaultEnabled: false,
  },
];

export function getLiteRtLmModelPreference(modelId: string): LiteRtLmModelPreference | undefined {
  return LITERTLM_MODEL_PREFERENCES.find((entry) => entry.modelId === modelId);
}

export function getDefaultLiteRtLmModelId(): string {
  return (
    LITERTLM_MODEL_PREFERENCES.find((entry) => entry.defaultEnabled)?.modelId ?? LITERTLM_MODEL_E2B
  );
}

export function buildLiteRtLmDiscoveredProvider() {
  return {
    api: PROVIDER_API,
    baseUrl: "litertlm://local",
    apiKey: "litertlm-local",
    models: LITERTLM_MODEL_PREFERENCES.map((entry) => ({
      id: entry.modelId,
      name: entry.displayName,
      provider: PROVIDER_ID,
      api: PROVIDER_API,
      contextWindow: 4096,
      reasoning: false,
      experimental: true,
    })),
  };
}
