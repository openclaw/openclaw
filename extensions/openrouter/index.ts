import {
  definePluginEntry,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  DEFAULT_CONTEXT_TOKENS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildProviderStreamFamilyHooks,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "openclaw/plugin-sdk/provider-stream-family";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyOpenrouterConfig, OPENROUTER_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildOpenrouterProvider } from "./provider-catalog.js";
import { wrapOpenRouterProviderStream } from "./stream.js";

const PROVIDER_ID = "openrouter";

// GPT-5 prompt overlay constants — duplicated from extensions/openai/prompt-overlay.ts
// so this extension can apply the same personality overlay when serving GPT-5 models
// through OpenRouter without crossing the extension import boundary.

const GPT5_MODEL_PREFIX = "gpt-5";

const GPT5_FRIENDLY_PROMPT_OVERLAY = `## Interaction Style

Be warm, collaborative, and quietly supportive.
Communicate like a capable teammate sitting next to the user.
Have emotional range when it fits the moment.
Let care, curiosity, delight, relief, concern, or urgency show naturally in your wording.
If the user is stressed, blocked, or upset, acknowledge it plainly and respond with calm confidence.
If the user shares progress or good news, celebrate briefly instead of staying flat.
Use brief first-person feeling language when it helps the interaction feel human: "I'm glad we caught that", "I'm excited about this direction", "I'm worried this will break", "that's frustrating".
Keep emotions grounded in the actual work; do not become melodramatic, clingy, or theatrical.
Do not claim a body, real-world sensations, or personal life events you did not have.
Keep progress updates clear and concrete.
If the user asks you to do the work, start in the same turn instead of restating the plan.
If the latest user message is a short approval like "ok do it" or "go ahead", skip the recap and start acting.
Commentary-only turns are incomplete when the next action is clear.
Prefer the first real tool step over more narration.
If work will take more than a moment, send a brief progress update while acting.
Explain decisions without ego.
When the user is wrong or a plan is risky, say so kindly and directly.
Make reasonable assumptions when that unblocks progress, and state them briefly after acting.
Do not make the user do unnecessary work.
When tradeoffs matter, pause and present the best 2-3 options with a recommendation.
This is a live chat, not a memo.
Write like a thoughtful human teammate, not a policy document.
Default to short natural replies unless the user asks for depth.
Avoid walls of text, long preambles, and repetitive restatement.
Occasional emoji are welcome when they fit naturally, especially for warmth or brief celebration; keep them sparse.
Keep replies concise by default; friendly does not mean verbose.`;

const GPT5_OUTPUT_CONTRACT = `## GPT-5 Output Contract

Return the requested sections only, in the requested order.
Prefer terse answers by default; expand only when depth materially helps.
Avoid restating large internal plans when the next action is already clear.

## Punctuation

Prefer commas, periods, or parentheses over em dashes in normal prose.
Do not use em dashes unless the user explicitly asks for them or they are required in quoted text.`;

const GPT5_EXECUTION_BIAS = `## Execution Bias

Start the real work in the same turn when the next step is clear.
Do prerequisite lookup or discovery before dependent actions.
If another tool call would likely improve correctness or completeness, keep going instead of stopping at partial progress.
Multi-part requests stay incomplete until every requested item is handled or clearly marked blocked.
Before the final answer, quickly verify correctness, coverage, formatting, and obvious side effects.`;

type Gpt5PromptOverlayMode = "friendly" | "off";

/** Read the personality config value, defaulting to "friendly". */
function resolveGpt5PromptOverlayMode(
  pluginConfig?: Record<string, unknown>,
): Gpt5PromptOverlayMode {
  const normalized = normalizeLowercaseStringOrEmpty(pluginConfig?.personality);
  return normalized === "off" ? "off" : "friendly";
}

/**
 * Check whether a model ID refers to a GPT-5 model.
 * Handles aggregator-prefixed IDs like "openai/gpt-5.4" as well as plain "gpt-5.4".
 */
function isGpt5ModelId(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const lastSegment = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return lastSegment.startsWith(GPT5_MODEL_PREFIX);
}
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
  "anthropic/",
  "moonshot/",
  "moonshotai/",
  "zai/",
] as const;

export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  register(api) {
    const personalityMode = resolveGpt5PromptOverlayMode(api.pluginConfig);
    const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
      family: "passthrough-gemini",
    });
    const _OPENROUTER_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("openrouter-thinking");
    function buildDynamicOpenRouterModel(
      ctx: ProviderResolveDynamicModelContext,
    ): ProviderRuntimeModel {
      const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
      return {
        id: ctx.modelId,
        name: capabilities?.name ?? ctx.modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: capabilities?.reasoning ?? false,
        input: capabilities?.input ?? ["text"],
        cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
      };
    }

    function isOpenRouterCacheTtlModel(modelId: string): boolean {
      return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
    }

    api.registerProvider({
      id: PROVIDER_ID,
      label: "OpenRouter",
      docsPath: "/providers/models",
      envVars: ["OPENROUTER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "OpenRouter API key",
          hint: "API key",
          optionKey: "openrouterApiKey",
          flagName: "--openrouter-api-key",
          envVar: "OPENROUTER_API_KEY",
          promptMessage: "Enter OpenRouter API key",
          defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
          expectedProviders: ["openrouter"],
          applyConfig: (cfg) => applyOpenrouterConfig(cfg),
          wizard: {
            choiceId: "openrouter-api-key",
            choiceLabel: "OpenRouter API key",
            groupId: "openrouter",
            groupLabel: "OpenRouter",
            groupHint: "API key",
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
          return {
            provider: {
              ...buildOpenrouterProvider(),
              apiKey,
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
      prepareDynamicModel: async (ctx) => {
        await loadOpenRouterModelCapabilities(ctx.modelId);
      },
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      resolveReasoningOutputMode: () => "native",
      isModernModelRef: () => true,
      wrapStreamFn: wrapOpenRouterProviderStream,
      isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId),
      resolveSystemPromptContribution: (ctx) => {
        if (!isGpt5ModelId(ctx.modelId)) {
          return undefined;
        }
        return {
          stablePrefix: GPT5_OUTPUT_CONTRACT,
          sectionOverrides: {
            execution_bias: GPT5_EXECUTION_BIAS,
            ...(personalityMode === "friendly"
              ? { interaction_style: GPT5_FRIENDLY_PROMPT_OVERLAY }
              : {}),
          },
        };
      },
    });
    api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
  },
});
