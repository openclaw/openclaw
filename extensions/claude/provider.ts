import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildClaudeProviderConfig,
  CLAUDE_APP_SERVER_AUTH_MARKER,
  CLAUDE_PROVIDER_ID,
  FALLBACK_CLAUDE_MODELS,
} from "./provider-catalog.js";

const CLAUDE_APP_SERVER_SETUP_METHOD_ID = "app-server";
const CLAUDE_DEFAULT_MODEL_REF = `${CLAUDE_PROVIDER_ID}/${FALLBACK_CLAUDE_MODELS[0].id}`;

type BuildClaudeProviderOptions = {
  pluginConfig?: unknown;
};

export function buildClaudeProvider(_options: BuildClaudeProviderOptions = {}): ProviderPlugin {
  return {
    id: CLAUDE_PROVIDER_ID,
    label: "Claude",
    docsPath: "/providers/models",
    auth: [
      {
        id: CLAUDE_APP_SERVER_SETUP_METHOD_ID,
        label: "Claude app-server",
        hint: "Use the @zeroaltitude/openclaw-claude-bridge runtime to drive Anthropic models.",
        kind: "custom",
        wizard: {
          choiceId: CLAUDE_PROVIDER_ID,
          choiceLabel: "Claude app-server",
          choiceHint: "Use the Claude app-server runtime and managed Anthropic model catalog.",
          assistantPriority: -30,
          groupId: CLAUDE_PROVIDER_ID,
          groupLabel: "Claude",
          groupHint: "Claude app-server bridge provider",
          onboardingScopes: ["text-inference"],
        },
        // The bridge resolves Anthropic auth itself via OAuth/CLI — the
        // OpenClaw-side profile is a sentinel so the model picker can
        // finalize the wizard. No interactive setup needed.
        run: async () => ({ profiles: [], defaultModel: CLAUDE_DEFAULT_MODEL_REF }),
      },
    ],
    staticCatalog: {
      order: "late",
      run: async () => ({
        provider: buildClaudeProviderConfig(FALLBACK_CLAUDE_MODELS),
      }),
    },
    resolveSyntheticAuth: () => ({
      apiKey: CLAUDE_APP_SERVER_AUTH_MARKER,
      source: "claude-app-server",
      mode: "token",
    }),
  };
}
