import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  buildProviderReplayFamilyHooks,
  matchesExactOrPrefix,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { applyOpencodeZenConfig, OPENCODE_ZEN_DEFAULT_MODEL } from "./api.js";

const PROVIDER_ID = "opencode";
const MINIMAX_MODERN_MODEL_MATCHERS = ["minimax-m2.7"] as const;

// GPT-5 prompt overlay constants — duplicated from extensions/openai/prompt-overlay.ts
// so this extension can apply the same personality overlay when serving GPT-5 models
// through OpenCode without crossing the extension import boundary.

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
const PASSTHROUGH_GEMINI_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "passthrough-gemini",
});

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
    const personalityMode = resolveGpt5PromptOverlayMode(api.pluginConfig);
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
          hint: "Shared API key for Zen + Go catalogs",
          optionKey: "opencodeZenApiKey",
          flagName: "--opencode-zen-api-key",
          envVar: "OPENCODE_API_KEY",
          promptMessage: "Enter OpenCode API key",
          profileIds: ["opencode:default", "opencode-go:default"],
          defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
          expectedProviders: ["opencode", "opencode-go"],
          applyConfig: (cfg) => applyOpencodeZenConfig(cfg),
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
            groupId: "opencode",
            groupLabel: "OpenCode",
            groupHint: "Shared API key for Zen + Go catalogs",
          },
        }),
      ],
      ...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
      isModernModelRef: ({ modelId }) => isModernOpencodeModel(modelId),
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
  },
});
