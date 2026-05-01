import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

export function createOpenPathsProvider(): ProviderPlugin {
  return {
    id: "openpaths",
    label: "OpenPaths",
    docsPath: "/providers/openpaths",
    envVars: ["OPENPATHS_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "OpenPaths API key",
        hint: "API key",
        run: async () => ({ profiles: [] }),
        wizard: {
          choiceId: "openpaths-api-key",
          choiceLabel: "OpenPaths API key",
          groupId: "openpaths",
          groupLabel: "OpenPaths",
          groupHint: "API key",
        },
      },
    ],
  };
}
