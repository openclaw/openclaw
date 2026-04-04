export const PROVIDER_ID = "litertlm-local";
export const PROVIDER_API = "ollama" as const;
export const SYNTHETIC_API_KEY = "litertlm-local";

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
    apiKey: SYNTHETIC_API_KEY,
    models: LITERTLM_MODEL_PREFERENCES.map((entry) => ({
      id: entry.modelId,
      name: entry.displayName,
      api: PROVIDER_API,
      reasoning: false,
      input: ["text"] as const,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 4096,
      maxTokens: 1024,
    })),
  };
}
