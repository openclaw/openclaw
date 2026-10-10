/** Preserves the session SDK's throwing summary API over agent-core results. */
import type { Model } from "../../../llm/types.js";
import {
  generateSummary as generateSummaryCore,
  type CompactionSummaryPrompt,
  type AgentMessage,
  type StreamFn,
  type ThinkingLevel,
} from "../../runtime/index.js";
import { unwrapCoreResult } from "../agent-session-utils.js";
import { createCompactionRuntime, type SessionModelUsageSink } from "./runtime.js";

export {
  estimateTokens,
  type CompactionPreparation,
  type CompactionResult,
} from "../../runtime/index.js";

/** Generates a compaction summary through the shared agent-core runtime. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
  usageSink?: SessionModelUsageSink,
  summaryPrompt?: CompactionSummaryPrompt,
): Promise<string> {
  return unwrapCoreResult(
    await generateSummaryCore(
      currentMessages,
      model,
      reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
      streamFn,
      createCompactionRuntime(usageSink),
      summaryPrompt,
    ),
  );
}
