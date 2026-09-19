import type { Model } from "@openclaw/llm-core";
import { resolveSummarizationRequestBudget } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  CompactionPlanningWorkerError,
  runCompactionPlanningWorker,
} from "./compaction-planning-worker-runtime.js";
/**
 * Runs CPU-heavy compaction planning in a worker thread when histories are
 * large enough to risk starving the main event loop.
 */
import {
  buildOversizedFallbackPlan,
  buildStageSplitPlan,
  buildSummaryChunks,
  computeAdaptiveChunkRatio,
  projectCompactionInlineMediaForTransfer,
  projectCompactionMessagesForPlanning,
  sanitizeCompactionMessages,
  type OversizedFallbackPlan,
  type StageSplitPlan,
} from "./compaction-planning.js";
import type {
  CompactionPlanningWorkerInput,
  CompactionPlanningWorkerValue,
} from "./compaction-planning.worker.js";
import type { AgentMessage, CompactionSummaryPrompt, ThinkingLevel } from "./runtime/index.js";

// Worker startup is more expensive than local planning for tiny histories.
// Keep small compactions synchronous; move only starvation-sized plans off-thread.
const COMPACTION_PLANNING_WORKER_MIN_MESSAGES = 64;

function restoreIndexedMessages(source: AgentMessage[], indexes: number[]): AgentMessage[] {
  return indexes.map((index) => {
    const message = source.at(index);
    if (!Number.isInteger(index) || index < 0 || !message) {
      throw new CompactionPlanningWorkerError(
        "compaction planning result contains an invalid message index",
        "failed",
      );
    }
    return message;
  });
}

function replacePlanningMessages(
  input: CompactionPlanningWorkerInput,
  messages: AgentMessage[],
): CompactionPlanningWorkerInput {
  switch (input.kind) {
    case "summaryChunks":
    case "oversizedFallback":
    case "stageSplit":
    case "summarizationStagePlan":
    case "adaptiveChunkRatio":
      return { ...input, messages };
    default:
      throw new CompactionPlanningWorkerError(
        "unsupported compaction planning input kind",
        "failed",
      );
  }
}

async function runCompactionPlan<TInput extends CompactionPlanningWorkerInput, TResult>(params: {
  input: TInput;
  signal?: AbortSignal;
  projectWorkerMessages?: boolean;
  fallback: (messages: AgentMessage[]) => TResult;
  restore: (
    value: Extract<CompactionPlanningWorkerValue, { kind: TInput["kind"] }>,
    messages: AgentMessage[],
  ) => TResult;
}): Promise<TResult> {
  params.signal?.throwIfAborted();
  const messages = sanitizeCompactionMessages(params.input.messages);
  if (messages.length < COMPACTION_PLANNING_WORKER_MIN_MESSAGES) {
    return params.fallback(messages);
  }

  try {
    const workerMessages =
      params.projectWorkerMessages === false
        ? // Exact budgeting needs real text, so the full planning projection is
          // skipped here. Inline media payloads are still dropped: they never
          // reach the serialized summary prompt, so transferring them would only
          // pay structured-clone cost.
          projectCompactionInlineMediaForTransfer(messages)
        : projectCompactionMessagesForPlanning(messages);
    const value = await runCompactionPlanningWorker({
      input: replacePlanningMessages(params.input, workerMessages),
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (value.kind !== params.input.kind) {
      throw new CompactionPlanningWorkerError(
        "unexpected compaction planning worker result",
        "failed",
      );
    }
    return params.restore(
      value as Extract<CompactionPlanningWorkerValue, { kind: TInput["kind"] }>,
      messages,
    );
  } catch (error) {
    if (error instanceof CompactionPlanningWorkerError && error.code === "unavailable") {
      params.signal?.throwIfAborted();
      return params.fallback(messages);
    }
    throw error;
  }
}

/** Builds summary chunks, offloading large histories to the planning worker. */
export async function buildSummaryChunksWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  signal?: AbortSignal;
}): Promise<AgentMessage[][]> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "summaryChunks", ...planningInput },
    signal,
    fallback: (messages) => buildSummaryChunks({ ...planningInput, messages }),
    restore: (value, messages) =>
      value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes)),
  });
}

/** Builds an oversized-message fallback plan, using the worker when worthwhile. */
export async function buildOversizedFallbackPlanWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<OversizedFallbackPlan> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "oversizedFallback", ...planningInput },
    signal,
    fallback: (messages) => buildOversizedFallbackPlan({ ...planningInput, messages }),
    restore: (value, messages) => ({
      smallMessages: restoreIndexedMessages(messages, value.smallMessageIndexes),
      oversizedNotes: value.oversizedNotes,
    }),
  });
}

/**
 * Computes the exact whole-request budget and stage split together. Large histories
 * stay off the runtime thread; small histories and unavailable workers keep the
 * completion owner's synchronous fallback semantics.
 */
export async function buildSummarizationStagePlanWithWorker(params: {
  messages: AgentMessage[];
  maxChunkTokens: number;
  parts?: number;
  minMessagesForSplit?: number;
  contextWindow?: number;
  customInstructions?: string;
  previousSummary?: string;
  summaryPrompt?: CompactionSummaryPrompt;
  model: Model;
  reserveTokens: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}): Promise<StageSplitPlan> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "summarizationStagePlan", ...planningInput },
    signal,
    projectWorkerMessages: false,
    fallback: (messages) => {
      const requestBudget = resolveSummarizationRequestBudget({ ...planningInput, messages });
      return buildStageSplitPlan({ ...planningInput, messages, ...requestBudget });
    },
    restore: (value, messages) =>
      value.mode === "split"
        ? {
            mode: "split",
            chunks: value.chunkIndexes.map((indexes) => restoreIndexedMessages(messages, indexes)),
          }
        : { mode: "single", fitsWholeRequest: value.fitsWholeRequest },
  });
}

/** Computes the adaptive compaction chunk ratio with worker fallback. */
export async function computeAdaptiveChunkRatioWithWorker(params: {
  messages: AgentMessage[];
  contextWindow: number;
  signal?: AbortSignal;
}): Promise<number> {
  const { signal, ...planningInput } = params;
  return runCompactionPlan({
    input: { kind: "adaptiveChunkRatio", ...planningInput },
    signal,
    fallback: () => computeAdaptiveChunkRatio(planningInput.messages, planningInput.contextWindow),
    restore: (value) => value.ratio,
  });
}
