import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { resolveCompletionTokenReservation } from "@openclaw/ai/transports";
import {
  resolveClaudeFable5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
  type StreamFn,
} from "@openclaw/llm-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { resolveAgentReasoningOption } from "../../reasoning.js";
import {
  type AgentCoreCompletionRuntimeDeps,
  consumeAgentCoreStream,
  resolveAgentCoreCompleteFn,
} from "../../runtime-deps.js";
import type { AgentMessage, ThinkingLevel } from "../../types.js";
import { convertToLlm } from "../messages.js";
import {
  CompactionError,
  err,
  InvalidSummaryOutputError,
  ok,
  SummaryOutputBudgetError,
  SummaryProviderError,
  type Result,
} from "../types.js";
import {
  createSummarizationContext,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./summarization-prompts.js";
import {
  extractSummaryText,
  MAX_SUMMARY_INPUT_CHARS,
  serializeConversationWithinBudget,
} from "./utils.js";

// Margin for the chars-per-token heuristic and the provider's message framing.
const SUMMARY_WINDOW_SAFETY_MARGIN = 1.2;
const SUMMARY_FRAMING_TOKENS = 1_024;
const OMITTED_ENTRIES_INSTRUCTION =
  "Some conversation entries were left out of this input where marked. Do not guess what they said. Keep facts from the previous summary that the shown entries do not change.";

/**
 * Smallest conversation budget worth a model call when the history must be
 * sampled. Below it the summarizer window cannot hold a useful sample next to
 * the instructions, previous summary and output, so compaction fails and keeps
 * the history.
 */
const MIN_SUMMARY_INPUT_CHARS = 4_000;
/**
 * Provider plugins may still raise the output limit after this request is
 * sized (a minimum output floor, larger thinking budgets). A provider overflow
 * then halves the conversation budget, at most this many times, before
 * compaction fails without retrying the same request.
 */
const MAX_OVERFLOW_SHRINKS = 2;

/**
 * Conversation budget for one summary request: the fixed cap, lowered when the
 * summarizer's own window cannot hold it next to the prompt and the largest
 * completion the transport may request.
 */
function resolveSummaryInputChars(
  model: Model,
  completionTokens: number,
  promptText: string,
): number {
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow <= 0) {
    return MAX_SUMMARY_INPUT_CHARS;
  }
  const windowChars =
    ((contextWindow - completionTokens - SUMMARY_FRAMING_TOKENS) * CHARS_PER_TOKEN_ESTIMATE) /
    SUMMARY_WINDOW_SAFETY_MARGIN;
  const available = Math.floor(
    windowChars -
      estimateStringChars(SUMMARIZATION_SYSTEM_PROMPT) -
      estimateStringChars(promptText),
  );
  return Math.min(MAX_SUMMARY_INPUT_CHARS, available);
}

export interface SummarizationCompletionParams {
  messages: AgentMessage[];
  prompt: string;
  customInstructions?: string;
  previousSummary?: string;
  model: Model;
  maxTokens: number;
  apiKey: string | undefined;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  runtime?: AgentCoreCompletionRuntimeDeps;
  errorLabel: string;
}

/** Runs one summarization completion and maps abort/error stops to CompactionError. */
export async function runSummarizationCompletion(
  params: SummarizationCompletionParams,
): Promise<Result<string, CompactionError>> {
  let instructions = "";
  if (params.previousSummary) {
    instructions += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  instructions += params.prompt;
  // SDK callers also pass generated policy here; the host bounds raw operator focus.
  if (params.customInstructions) {
    instructions += `\n\nAdditional focus: ${params.customInstructions}`;
  }
  const { model, thinkingLevel, maxTokens, signal, apiKey, headers } = params;
  const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
  const fableReasoning =
    (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model) !== undefined;
  if ((model.reasoning || fableReasoning) && thinkingLevel) {
    options.reasoning = resolveAgentReasoningOption(model, thinkingLevel);
  }
  const completionTokens = resolveCompletionTokenReservation(model, maxTokens, options.reasoning);
  const fullBudget = resolveSummaryInputChars(
    model,
    completionTokens,
    `${instructions}\n\n${OMITTED_ENTRIES_INSTRUCTION}`,
  );
  const budgetError = () =>
    err<string, CompactionError>(
      new SummaryOutputBudgetError(
        `${params.errorLabel} needs more room than ${model.provider}/${model.id} has: its ${model.contextWindow}-token window cannot hold the conversation next to the instructions, previous summary and ${completionTokens}-token output. Set agents.defaults.compaction.model to a model with a larger context window.`,
      ),
    );
  // A negative budget means the instructions alone overflow the window.
  if (fullBudget < 0) {
    return budgetError();
  }
  const llmMessages = convertToLlm(params.messages);
  let conversationBudget = fullBudget;
  let response;
  for (let shrink = 0; ; shrink += 1) {
    const conversation = serializeConversationWithinBudget(llmMessages, conversationBudget);
    const sampled = conversation.omittedEntries > 0 || conversation.trimmedEntries > 0;
    // A history that fits is sent unchanged; only a sample needs the minimum room.
    if (sampled && conversationBudget < MIN_SUMMARY_INPUT_CHARS) {
      return budgetError();
    }
    const omissionNote =
      conversation.omittedEntries > 0 ? `${OMITTED_ENTRIES_INSTRUCTION}\n\n` : "";
    const context = createSummarizationContext(
      `<conversation>\n${conversation.text}\n</conversation>\n\n${omissionNote}${instructions}`,
    );
    response = params.streamFn
      ? await consumeAgentCoreStream(
          params.streamFn(params.model, context, options),
          params.runtime,
        )
      : await resolveAgentCoreCompleteFn(params.runtime)(params.model, context, options);
    // Usage belongs to the completed provider request even when its summary is invalid.
    params.runtime?.internalUsageSink?.(response.usage);
    if (response.stopReason === "aborted" || !isContextOverflow(response, model.contextWindow)) {
      break;
    }
    // Caller cancellation is terminal; never start another request after it.
    if (signal?.aborted) {
      return err(new CompactionError("aborted", `${params.errorLabel} aborted`));
    }
    if (shrink >= MAX_OVERFLOW_SHRINKS) {
      return budgetError();
    }
    conversationBudget = Math.floor(
      Math.min(conversationBudget, estimateStringChars(conversation.text)) / 2,
    );
  }
  if (response.stopReason === "aborted") {
    return err(
      new CompactionError("aborted", response.errorMessage || `${params.errorLabel} aborted`),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new SummaryProviderError(
        `${params.errorLabel} failed: ${response.errorMessage || "Unknown error"}`,
        response,
      ),
    );
  }

  const summary = extractSummaryText(response);
  if (summary === undefined) {
    if (response.stopReason === "length") {
      return err(
        new SummaryOutputBudgetError(
          `${params.errorLabel} failed: summary output budget (${params.maxTokens} tokens) was exhausted without visible text; reduce thinking or increase the selected model's maxTokens before retrying`,
        ),
      );
    }
    return err(
      new InvalidSummaryOutputError(`${params.errorLabel} failed: model returned no summary text`),
    );
  }
  return ok(summary);
}
