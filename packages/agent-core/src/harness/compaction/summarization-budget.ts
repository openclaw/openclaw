/**
 * Transport-aware budgeting for summarization requests.
 *
 * Extracted from compaction.ts to keep that file under its line cap. How much
 * output a summarization request may claim depends on which transport will
 * actually execute it, and those per-transport contracts (managed-alias
 * narrowing, and the Bedrock vs Anthropic-direct subminimum fallback) are one
 * coherent concern.
 */
import { adjustMaxTokensForThinking } from "@openclaw/ai/providers";
import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  supportsClaudeAdaptiveThinking,
  type Model,
  type SimpleStreamOptions,
} from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { buildSummarizationPromptText } from "./summarization-completion.js";
import {
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  TURN_PREFIX_SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from "./summarization-prompts.js";

/** Caller-owned formats replace the default headings; focus remains additive. */
export type CompactionSummaryPrompt =
  | { kind: "turn-prefix" }
  | { kind: "custom"; instructions: string };

function createSummarizationOptions(
  model: Model,
  maxTokens: number,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  return options;
}

/** Managed-transport alias applied when the host requires OpenClaw's HTTP transport. */
const MANAGED_ANTHROPIC_TRANSPORT_API = "openclaw-anthropic-messages-transport";

/** Returns whether the api is the managed Anthropic Messages transport alias. */
function isManagedAnthropicTransportApi(api: string): boolean {
  return api === MANAGED_ANTHROPIC_TRANSPORT_API;
}

/** Anthropic disables thinking below this budget; transports then diverge on maxTokens. */
const ANTHROPIC_MIN_THINKING_BUDGET_TOKENS = 1024;

/** Returns whether the api routes through Anthropic Messages, alias included. */
function isAnthropicMessagesApi(api: string): boolean {
  return api === "anthropic-messages" || isManagedAnthropicTransportApi(api);
}

function isClaudeBedrockModel(model: Model): boolean {
  if (model.api !== "bedrock-converse-stream") {
    return false;
  }
  if (resolveClaudeModelIdentity(model).startsWith("claude-")) {
    return true;
  }
  const id = model.id.toLowerCase();
  const name = model.name?.toLowerCase() ?? "";
  return (
    id.includes("anthropic.claude") ||
    id.includes("anthropic/claude") ||
    name.includes("anthropic.claude") ||
    name.includes("anthropic/claude") ||
    name.includes("claude")
  );
}

/**
 * Returns the thinking level the model's executing transport will actually pass
 * to `adjustMaxTokensForThinking`.
 *
 * `adjustMaxTokensForThinking` natively supports "max" (32 768) and only clamps
 * "xhigh" internally, so any max->high narrowing is a per-transport decision:
 *
 * - `streamSimpleAnthropic` (packages/ai/src/providers/anthropic.ts) forwards
 *   `reasoning` unchanged. This is the default simple-runtime route for
 *   `anthropic-messages`, registered as `streamSimple` in register-builtins.ts.
 * - `resolveSimpleBedrockOptions` (extensions/amazon-bedrock/stream.runtime.ts)
 *   likewise forwards the requested level unchanged.
 * - The managed transport stream (packages/ai/src/transports/anthropic-transport-stream.ts)
 *   coerces "max" to "high". It only runs when the host reports a managed
 *   transport requirement (request.proxy / request.tls / localService), which
 *   `prepareTransportAwareSimpleModel` signals by rewriting `model.api` to the
 *   `openclaw-anthropic-messages-transport` alias.
 *
 * Budgeting therefore follows the alias: an un-aliased model keeps the
 * requested level, and only the managed-transport alias narrows "max".
 */
function resolveTransportThinkingLevel<TLevel extends Exclude<ThinkingLevel, "off">>(
  model: Model,
  reasoning: TLevel,
): TLevel | "high" {
  return isManagedAnthropicTransportApi(model.api) && reasoning === "max" ? "high" : reasoning;
}

function resolveSummarizationCompletionAllowance(params: {
  model: Model;
  maxTokens: number;
  thinkingLevel?: ThinkingLevel;
}): number {
  const options = createSummarizationOptions(
    params.model,
    params.maxTokens,
    undefined,
    undefined,
    undefined,
    params.thinkingLevel,
  );
  const reasoning = options.reasoning;
  if (
    !reasoning ||
    reasoning === "off" ||
    (!isAnthropicMessagesApi(params.model.api) && !isClaudeBedrockModel(params.model)) ||
    supportsClaudeAdaptiveThinking(params.model)
  ) {
    return params.maxTokens;
  }
  const adjusted = adjustMaxTokensForThinking(
    params.maxTokens,
    params.model.maxTokens,
    resolveTransportThinkingLevel(params.model, reasoning),
    options.thinkingBudgets,
  );
  if (adjusted.thinkingBudget >= ANTHROPIC_MIN_THINKING_BUDGET_TOKENS) {
    return adjusted.maxTokens;
  }
  // Below the 1024 minimum each transport disables thinking, but they do not
  // agree on the resulting output cap, so the budget must not under-reserve for
  // whichever one will actually execute:
  //
  // - Anthropic-direct (`streamSimpleAnthropic`) restores the visible-output cap
  //   via `clampMaxTokensToModel(model, options.maxTokens ?? model.maxTokens)`.
  // - The managed transport and Bedrock keep the larger `adjusted.maxTokens`.
  //
  // Planning cannot tell which one will run: the managed Anthropic transport is
  // selected for default, runtime-auth-resolved and proxied models
  // (embedded-agent-runner/stream-resolution.ts:~188) and passed in as a
  // standalone `streamFn` *without* rewriting `model.api` to the managed alias,
  // so keying on the alias alone misses that live combination and under-budgets
  // it to the direct cap. Reserve the larger managed cap for every
  // Anthropic-messages model (aliased or not) and Bedrock; only a model that
  // cannot reach the managed transport at all keeps the direct visible cap.
  // Over-reserving is the safe direction: it can only decline a borderline
  // single-pass, never approve one the provider then rejects for lack of output
  // headroom.
  if (isAnthropicMessagesApi(params.model.api) || isClaudeBedrockModel(params.model)) {
    return adjusted.maxTokens;
  }
  return Math.min(params.maxTokens, params.model.maxTokens ?? params.maxTokens);
}

/** Resolves the completion budget shared by compaction planning and execution. */
export function resolveSummaryOutputTokens(params: {
  reserveTokens: number;
  modelMaxTokens: number;
  reserveRatio?: number;
}): number {
  return Math.min(
    Math.floor((params.reserveRatio ?? 0.8) * params.reserveTokens),
    params.modelMaxTokens > 0 ? params.modelMaxTokens : Number.POSITIVE_INFINITY,
  );
}

/** The exact request pressure consumed by the summarization completion owner. */
export function resolveSummarizationRequestBudget(params: {
  messages: AgentMessage[];
  customInstructions?: string;
  previousSummary?: string;
  summaryPrompt?: CompactionSummaryPrompt;
  model: Model;
  reserveTokens: number;
  thinkingLevel?: ThinkingLevel;
}): { singlePassInputTokens: number; completionAllowanceTokens: number } {
  const maxTokens = resolveSummaryOutputTokens({
    reserveTokens: params.reserveTokens,
    modelMaxTokens: params.model.maxTokens,
    reserveRatio: params.summaryPrompt?.kind === "turn-prefix" ? 0.5 : 0.8,
  });
  const promptText = buildSummarizationPromptText({
    ...params,
    prompt: resolveSummaryPrompt(params),
  });
  const inputChars =
    estimateStringChars(SUMMARIZATION_SYSTEM_PROMPT) + estimateStringChars(promptText);
  return {
    singlePassInputTokens: Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE),
    completionAllowanceTokens: resolveSummarizationCompletionAllowance({
      model: params.model,
      maxTokens,
      thinkingLevel: params.thinkingLevel,
    }),
  };
}

export function resolveSummaryPrompt(params: {
  previousSummary?: string;
  summaryPrompt?: CompactionSummaryPrompt;
}): string {
  const selectedPrompt =
    params.summaryPrompt?.kind === "turn-prefix"
      ? TURN_PREFIX_SUMMARIZATION_PROMPT
      : params.summaryPrompt?.instructions;
  return params.summaryPrompt
    ? [
        params.previousSummary &&
          "Update the previous summary with the new conversation. Preserve relevant facts, decisions, and unresolved asks; remove stale or duplicate detail. Use the format below.",
        selectedPrompt,
      ]
        .filter(Boolean)
        .join("\n\n")
    : params.previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
}
