import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";

const PROVIDER_ID = "cursor-sdk";
const ENV_VAR = "CURSOR_API_KEY";
const DEFAULT_MODEL_REF = `${PROVIDER_ID}/composer-2`;

// The Cursor SDK manages its own endpoints; this is only used to satisfy
// the provider metadata type requirements (baseUrl is required by Model<Api>).
const CURSOR_SDK_BASE_URL = "https://api2.cursor.sh/v1";

export function registerCursorSdkProvider(api: OpenClawPluginApi): void {
  api.registerProvider({
    id: PROVIDER_ID,
    label: "Cursor SDK",
    envVars: [ENV_VAR],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: "Cursor API key",
        hint: "Cursor SDK agent access via @cursor/sdk",
        optionKey: "cursorApiKey",
        flagName: "--cursor-api-key",
        envVar: ENV_VAR,
        promptMessage: "Enter Cursor API key",
        defaultModel: DEFAULT_MODEL_REF,
        expectedProviders: [PROVIDER_ID],
        applyConfig: (cfg) => cfg,
        wizard: {
          choiceId: "cursor-sdk-api-key",
          choiceLabel: "Cursor API key",
          groupId: "cursor-sdk",
          groupLabel: "Cursor SDK",
          groupHint: "Local & cloud Cursor agents via @cursor/sdk",
        },
      }),
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        // Model enumeration is intentionally empty — the Cursor SDK validates
        // models internally and resolveDynamicModel handles all resolution.
        return {
          provider: {
            baseUrl: CURSOR_SDK_BASE_URL,
            models: [],
            apiKey,
          },
        };
      },
    },
    // Accept any model id — the Cursor SDK validates models internally.
    // This prevents model_not_found errors in OpenClaw's resolution pipeline.
    resolveDynamicModel: ({ modelId }) => ({
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      provider: PROVIDER_ID,
      baseUrl: CURSOR_SDK_BASE_URL,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
    }),
  });
}
