import {
  CompactionError,
  SummaryOutputBudgetError,
} from "../../packages/agent-core/src/harness/types.js";
import type { AgentCompactionIdentifierPolicy } from "../config/types.agent-defaults.js";
import { isAbortError } from "../infra/abort-signal.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sanitizeCompactionMessages } from "./compaction-planning.js";
import { isTimeoutError } from "./failover-error.js";
import type {
  AgentMessage,
  CompactionSummaryPrompt,
  StreamFn,
  ThinkingLevel,
} from "./runtime/index.js";
import type { SessionModelUsageSink } from "./sessions/compaction/runtime.js";
import type { ExtensionContext } from "./sessions/index.js";
import { generateSummary } from "./sessions/index.js";
export { estimateMessagesTokens } from "./compaction-planning.js";

const log = createSubsystemLogger("compaction");

const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, hostnames, IPs, ports, URLs, and file names.";

export type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy | "custom";
  identifierInstructions?: string;
};

type CompactionSummaryParams = {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  customInstructions?: string;
  summaryPrompt?: CompactionSummaryPrompt;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
  thinkingLevel?: ThinkingLevel;
  streamFn?: StreamFn;
  usageSink?: SessionModelUsageSink;
};

function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const custom = customInstructions?.trim();
  const identifierPreservation =
    instructions?.identifierPolicy === "off"
      ? undefined
      : instructions?.identifierPolicy === "custom"
        ? instructions.identifierInstructions?.trim() || IDENTIFIER_PRESERVATION_INSTRUCTIONS
        : IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  if (!custom) {
    return identifierPreservation;
  }
  return identifierPreservation
    ? `${identifierPreservation}\n\nAdditional focus:\n${custom}`
    : `Additional focus:\n${custom}`;
}

/**
 * Summarizes compaction history in one model request. The request serializer
 * bounds its input (see serializeConversationWithinBudget), so latency and cost
 * do not grow with the session or the context window.
 */
export async function summarizeCompactionHistory(params: CompactionSummaryParams): Promise<string> {
  // SECURITY: toolResult.details and runtime-context entries never reach the summarizer.
  const messages = sanitizeCompactionMessages(params.messages);
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const instructions = buildCompactionSummarizationInstructions(
    params.customInstructions,
    params.summarizationInstructions,
  );
  try {
    return await retryAsync(
      () =>
        generateSummary(
          messages,
          params.model,
          params.reserveTokens,
          params.apiKey,
          params.headers,
          params.signal,
          instructions,
          params.previousSummary,
          params.thinkingLevel,
          params.streamFn,
          params.usageSink,
          params.summaryPrompt,
        ),
      {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 5000,
        jitter: 0.2,
        label: "compaction/generateSummary",
        // Backoff must honor caller cancellation; otherwise an abort during
        // the sleep would stall compaction until the full delay elapses.
        sleep: (ms) => sleepWithAbort(ms, params.signal),
        // Caller aborts and transport timeouts are terminal; provider-side
        // AbortErrors without caller cancellation remain retryable.
        shouldRetry: (err) =>
          !params.signal.aborted &&
          !(err instanceof SummaryOutputBudgetError) &&
          (isAbortError(err) || !isTimeoutError(err)),
      },
    );
  } catch (err) {
    if (params.signal.aborted) {
      throw err;
    }
    log.warn(`Summarization failed: ${formatErrorMessage(err)}`);
    throw new CompactionError(
      "summarization_failed",
      `Summarization failed for ${messages.length} messages: ${formatErrorMessage(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
}
