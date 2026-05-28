import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  matchesExactOrPrefix,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyOpencodeZenConfig, OPENCODE_ZEN_DEFAULT_MODEL } from "./api.js";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;
const OPENCODE_SHARED_HINT = "Prefers OPENCODE_ZEN_API_KEY; falls back to shared OPENCODE_API_KEY";
const OPENCODE_SHARED_WIZARD_GROUP = {
  groupId: "opencode",
  groupLabel: "OpenCode",
  groupHint: OPENCODE_SHARED_HINT,
} as const;

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "OpenCode Zen Provider",
  description: "Bundled OpenCode Zen provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenCode Zen",
      docsPath: "/providers/models",
      envVars: ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OpenCode Zen catalog",
          hint: OPENCODE_SHARED_HINT,
          optionKey: "opencodeZenApiKey",
          flagName: "--opencode-zen-api-key",
          envVar: "OPENCODE_ZEN_API_KEY",
          promptMessage: "Enter OpenCode Zen API key",
          defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
          applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
          noteMessage: [
            "OpenCode Zen prefers OPENCODE_ZEN_API_KEY.",
            "If you use a shared OpenCode key instead, OPENCODE_API_KEY still works.",
            "Zen provides access to Claude, GPT, Gemini, and more models.",
            "Get your API key at: https://opencode.ai/auth",
            "Choose the Zen catalog when you want the curated multi-model proxy.",
          ].join("\n"),
          noteTitle: "OpenCode",
          wizard: {
            choiceId: "opencode-zen",
            choiceLabel: "OpenCode Zen catalog",
            ...OPENCODE_SHARED_WIZARD_GROUP,
          },
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
      resolveThinkingProfile: ({ modelId }) => resolveClaudeThinkingProfile(modelId),
    });
    api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
  },
});
