import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type AuthStorage, estimateTokens, generateSummary } from "@mariozechner/pi-coding-agent";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import type { SummaryEntry } from "./summary-store.js";
import { log } from "../pi-embedded-runner/logger.js";
import { extractContentText, extractToolInfo } from "./message-utils.js";
import { loadSummaryStore, saveSummaryStore } from "./summary-store.js";
import { computeTurnAges } from "./turn-ages.js";

/** Reserve tokens for the summarization model response. */
const SUMMARY_RESERVE_TOKENS = 500;

/**
 * Build the summarization prompt for a tool result.
 */
function buildSummarizationPrompt(toolName: string, args: string, content: string): string {
  return [
    "Summarize this tool call result concisely. Preserve: file paths, function names, error messages, key values, line numbers. Omit raw content that can be re-fetched.",
    "",
    `Tool: ${toolName}`,
    `Arguments: ${args}`,
    "",
    "Result:",
    content,
  ].join("\n");
}

/**
 * Summarize aged tool results that don't yet have summaries.
 * This is fire-and-forget — failures are logged but don't affect the agent run.
 */
export async function summarizeAgedToolResults(params: {
  sessionFilePath: string;
  messages: AgentMessage[];
  config: ContextDecayConfig;
  model: NonNullable<ExtensionContext["model"]>;
  authStorage: AuthStorage;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sessionFilePath, messages, config, model, authStorage, abortSignal } = params;

  const summarizeAfter = config.summarizeToolResultsAfterTurns;

  if (!summarizeAfter || summarizeAfter < 1) {
    return;
  }

  const existingSummaries = await loadSummaryStore(sessionFilePath);
  const turnAges = computeTurnAges(messages);
  const toSummarize: Array<{ index: number; toolName: string; args: string; content: string }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (abortSignal?.aborted) {
      return;
    }

    const msg = messages[i];
    if (msg.role !== "toolResult") {
      continue;
    }

    const age = turnAges.get(i) ?? 0;
    if (age < summarizeAfter) {
      continue;
    }
    // Skip tool results past the strip threshold — they'll be stripped in the view anyway,
    // so summarizing them would waste API calls on summaries that are never displayed.
    if (config.stripToolResultsAfterTurns && age >= config.stripToolResultsAfterTurns) {
      continue;
    }
    if (existingSummaries[i]) {
      continue;
    }

    const content = extractContentText(msg);
    // Skip very short results (not worth summarizing)
    if (content.length < 200) {
      continue;
    }

    const { toolName, args } = extractToolInfo(messages, i);
    toSummarize.push({ index: i, toolName, args, content });
  }

  if (toSummarize.length === 0) {
    return;
  }

  // Resolve API key from auth storage for the model's provider
  const apiKey = await authStorage.getApiKey(model.provider);
  if (!apiKey) {
    log.warn(
      `context-decay: no API key found for provider "${model.provider}"; skipping summarization`,
    );
    return;
  }

  log.info(
    `context-decay: summarizing ${toSummarize.length} aged tool result(s) with ${model.provider}/${model.id}`,
  );

  const updatedStore = { ...existingSummaries };
  let didUpdate = false;

  for (const item of toSummarize) {
    if (abortSignal?.aborted) {
      break;
    }

    try {
      // Truncate args independently to prevent them from pushing tool result content off the end
      const truncatedArgs = item.args.length > 500 ? item.args.slice(0, 500) + "..." : item.args;
      const prompt = buildSummarizationPrompt(item.toolName, truncatedArgs, item.content);

      // Truncate very long content to avoid excessive summarization costs
      const maxPromptChars = 50_000;
      const truncatedPrompt =
        prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) + "\n[truncated]" : prompt;

      const summaryMessages: AgentMessage[] = [
        {
          role: "user",
          content: truncatedPrompt,
          timestamp: Date.now(),
        } as AgentMessage,
      ];

      const summaryText = await generateSummary(
        summaryMessages,
        model,
        SUMMARY_RESERVE_TOKENS,
        apiKey,
        abortSignal ?? new AbortController().signal,
      );

      if (summaryText && summaryText.length > 0) {
        const originalMsg = {
          role: "user",
          content: item.content,
          timestamp: Date.now(),
        } as AgentMessage;
        const summaryMsg = {
          role: "user",
          content: summaryText,
          timestamp: Date.now(),
        } as AgentMessage;
        const entry: SummaryEntry = {
          summary: summaryText,
          originalTokenEstimate: estimateTokens(originalMsg),
          summaryTokenEstimate: estimateTokens(summaryMsg),
          summarizedAt: new Date().toISOString(),
          model: `${model.provider}/${model.id}`,
        };
        updatedStore[item.index] = entry;
        didUpdate = true;
      }
    } catch (err) {
      log.warn(
        `context-decay: failed to summarize tool result at index ${item.index}: ${String(err)}`,
      );
    }
  }

  if (didUpdate) {
    try {
      await saveSummaryStore(sessionFilePath, updatedStore);
      log.info(`context-decay: saved ${Object.keys(updatedStore).length} summaries`);
    } catch (err) {
      log.warn(`context-decay: failed to save summary store: ${String(err)}`);
    }
  }
}
