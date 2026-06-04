// Fireworks plugin entrypoint registers its OpenClaw integration.
import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  applyModelCompatPatch,
  cloneFirstTemplateModel,
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  isFireworksDeepSeekV4ModelId,
  isFireworksGlmModelId,
  isFireworksGlmReasoningModelId,
  isFireworksGptOss120bModelId,
  isFireworksKimiModelId,
  isFireworksMinimaxM2ModelId,
} from "./model-id.js";
import { applyFireworksConfig, FIREWORKS_DEFAULT_MODEL_REF } from "./onboard.js";
import {
  buildFireworksProvider,
  FIREWORKS_BASE_URL,
  FIREWORKS_DEEPSEEK_V4_COMPAT,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
  FIREWORKS_GLM_COMPAT,
  FIREWORKS_GPT_OSS_COMPAT,
  FIREWORKS_MINIMAX_M2_COMPAT,
} from "./provider-catalog.js";
import { wrapFireworksProviderStream } from "./stream.js";
import { resolveFireworksThinkingProfile } from "./thinking-policy.js";

const PROVIDER_ID = "fireworks";

function resolveFireworksDynamicInput(modelId: string): Array<"text" | "image"> {
  return isFireworksGlmModelId(modelId) ? ["text"] : ["text", "image"];
}

// Same matchers as the thinking profiles in thinking-policy.ts: a dynamic id
// that advertises a profile must also carry the effort compat that encodes it
// (Fireworks' proxy-like endpoint disables detected reasoning_effort), and
// deepseek-v4* additionally needs the thinkingFormat opt-out — core's
// deepseek-native fallback matches the id family and Fireworks 400s on
// `thinking` next to `reasoning_effort`.
const FIREWORKS_DYNAMIC_FAMILY_COMPAT = [
  { matches: isFireworksDeepSeekV4ModelId, compat: FIREWORKS_DEEPSEEK_V4_COMPAT },
  { matches: isFireworksMinimaxM2ModelId, compat: FIREWORKS_MINIMAX_M2_COMPAT },
  { matches: isFireworksGlmReasoningModelId, compat: FIREWORKS_GLM_COMPAT },
  { matches: isFireworksGptOss120bModelId, compat: FIREWORKS_GPT_OSS_COMPAT },
] as const;

function resolveFireworksDynamicModel(ctx: ProviderResolveDynamicModelContext) {
  const modelId = ctx.modelId.trim();
  if (!modelId) {
    return undefined;
  }
  const isKimiModel = isFireworksKimiModelId(modelId);
  const input = resolveFireworksDynamicInput(modelId);

  const resolved =
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId,
      templateIds: [FIREWORKS_DEFAULT_MODEL_ID],
      ctx,
      patch: {
        provider: PROVIDER_ID,
        reasoning: !isKimiModel,
        input,
      },
    }) ??
    normalizeModelCompat({
      id: modelId,
      name: modelId,
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: FIREWORKS_BASE_URL,
      reasoning: !isKimiModel,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS || DEFAULT_CONTEXT_TOKENS,
    });
  // Merged, not replaced, so template compat (unsupportedToolSchemaKeywords)
  // survives.
  const familyCompat = FIREWORKS_DYNAMIC_FAMILY_COMPAT.find((entry) =>
    entry.matches(modelId),
  )?.compat;
  return familyCompat ? applyModelCompatPatch(resolved, familyCompat) : resolved;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Fireworks Provider",
  description: "Bundled Fireworks AI provider plugin",
  provider: {
    label: "Fireworks",
    aliases: ["fireworks-ai"],
    docsPath: "/providers/fireworks",
    auth: [
      {
        methodId: "api-key",
        label: "Fireworks API key",
        hint: "API key",
        optionKey: "fireworksApiKey",
        flagName: "--fireworks-api-key",
        envVar: "FIREWORKS_API_KEY",
        promptMessage: "Enter Fireworks API key",
        defaultModel: FIREWORKS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyFireworksConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildFireworksProvider,
      allowExplicitBaseUrl: true,
    },
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    wrapStreamFn: wrapFireworksProviderStream,
    resolveThinkingProfile: ({ modelId }) => resolveFireworksThinkingProfile(modelId),
    resolveDynamicModel: (ctx) => resolveFireworksDynamicModel(ctx),
    isModernModelRef: () => true,
  },
});
