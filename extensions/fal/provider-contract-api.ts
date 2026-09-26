import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "fal";

export function createFalAuthMethodMetadata() {
  return {
    label: "fal API key",
    hint: "Image, video, and music generation API key",
    wizard: {
      choiceId: "fal-api-key",
      choiceLabel: "fal API key",
      choiceHint: "Image, video, and music generation API key",
      groupId: "fal",
      groupLabel: "fal",
      groupHint: "Image, video, and music generation",
      onboardingScopes: ["image-generation", "music-generation"],
    },
  } satisfies Pick<ProviderPlugin["auth"][number], "label" | "hint" | "wizard">;
}

export function createFalProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "fal",
    docsPath: "/providers/models",
    envVars: ["FAL_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        ...createFalAuthMethodMetadata(),
        run: async () => ({ profiles: [] }),
      },
    ],
  };
}
