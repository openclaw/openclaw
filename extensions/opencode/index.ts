import { definePluginEntry, type ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  matchesExactOrPrefix,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { applyOpencodeZenConfig, OPENCODE_ZEN_DEFAULT_MODEL } from "./api.js";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;
const OPENCODE_SHARED_PROFILE_IDS = ["opencode:default", "opencode-go:default"] as const;
const OPENCODE_SHARED_HINT = "Shared API key for Zen + Go catalogs";
const OPENCODE_SHARED_WIZARD_GROUP = {
  groupId: "opencode",
  groupLabel: "OpenCode",
  groupHint: OPENCODE_SHARED_HINT,
} as const;
const ANTHROPIC_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"] as const;
const ANTHROPIC_ADAPTIVE_MODEL_PREFIXES = [
  "claude-opus-4-6",
  "claude-opus-4.6",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
] as const;
const BASE_ANTHROPIC_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

function isModernOpencodeModel(modelId: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  if (lower.endsWith("-free") || lower === "alpha-glm-4.7") {
    return false;
  }
  return !matchesExactOrPrefix(lower, MINIMAX_MODERN_MODEL_MATCHERS);
}

function matchesAnyPrefix(modelId: string, prefixes: readonly string[]): boolean {
  const lower = normalizeLowercaseStringOrEmpty(modelId);
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

function resolveOpencodeThinkingProfile(modelId: string): ProviderThinkingProfile {
  if (matchesAnyPrefix(modelId, ANTHROPIC_OPUS_47_MODEL_PREFIXES)) {
    return {
      levels: [
        ...BASE_ANTHROPIC_THINKING_LEVELS,
        { id: "xhigh" },
        { id: "adaptive" },
        { id: "max" },
      ],
      defaultLevel: "off",
    };
  }
  if (matchesAnyPrefix(modelId, ANTHROPIC_ADAPTIVE_MODEL_PREFIXES)) {
    return {
      levels: [...BASE_ANTHROPIC_THINKING_LEVELS, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE_ANTHROPIC_THINKING_LEVELS };
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
      envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OpenCode Zen catalog",
          hint: OPENCODE_SHARED_HINT,
          optionKey: "opencodeZenApiKey",
          flagName: "--opencode-zen-api-key",
          envVar: "OPENCODE_API_KEY",
          promptMessage: "Enter OpenCode API key",
          profileIds: [...OPENCODE_SHARED_PROFILE_IDS],
          defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
          applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
          expectedProviders: ["opencode", "opencode-go"],
          noteMessage: [
            "OpenCode uses one API key across the Zen and Go catalogs.",
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
      resolveThinkingProfile: ({ modelId }) => resolveOpencodeThinkingProfile(modelId),
    });
    api.registerMediaUnderstandingProvider(opencodeMediaUnderstandingProvider);
  },
});
