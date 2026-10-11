import { isDeepStrictEqual } from "node:util";
import { supportsNativeOpenAIResponsesEndpoint } from "@openclaw/ai/internal/openai-responses-payload-policy";
import {
  captureOpenAIResponsesCompaction,
  requestPreparedOpenAIResponsesCompaction,
  requiresCompactionReplayRefresh,
  resolveOpenAIResponsesCompactEndpointPlan,
} from "@openclaw/ai/transports";
import type { Message } from "@openclaw/llm-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { AgentMessage } from "../runtime/index.js";
import type { CompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { withSessionManagerWrite } from "../sessions/session-manager-write-admission.js";
import { sanitizeTranscriptMessage } from "../transcript-sanitize.js";
import { compactWithSafetyTimeout } from "./compaction-safety-timeout.js";
import { log } from "./logger.js";
import {
  estimateLlmBoundaryTokenPressure,
  estimateRenderedLlmBoundaryTokenPressure,
} from "./run/preemptive-compaction.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

type SessionManagerLike = Parameters<
  typeof rewriteTranscriptEntriesInSessionManager
>[0]["sessionManager"];

type ServerEndpointCompactionResult = Awaited<
  ReturnType<typeof requestPreparedOpenAIResponsesCompaction>
>;

/** Try provider-owned compaction and persist its replay checkpoint on the session owner. */
export async function attemptServerEndpointCompaction(params: {
  trigger: "budget" | "overflow" | "manual";
  streamFn: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[0];
  model: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[1];
  context: { systemPrompt: string; messages: readonly AgentMessage[] };
  sessionManager: SessionManagerLike;
  extraParams: Record<string, unknown>;
  requestOptions: Parameters<typeof requestPreparedOpenAIResponsesCompaction>[3];
  requestBudget?: CompactionRequestBudget;
  customInstructions?: string;
  config?: OpenClawConfig;
  onUsage?: (usage: ServerEndpointCompactionResult["usage"]) => void;
  onCompactionCommitted?: (tokensBefore: number) => void;
  assertActive?: () => void;
}): Promise<ServerEndpointCompactionResult | undefined> {
  if (
    params.trigger === "overflow" ||
    params.customInstructions?.trim() ||
    !resolveOpenAIResponsesCompactEndpointPlan(params.model, params.extraParams).enabled
  ) {
    return undefined;
  }
  params.assertActive?.();
  let compactionCommitted = false;
  try {
    const messages = params.context.messages.filter(
      (message): message is Message =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    if (messages.at(-1)?.role !== "assistant") {
      log.warn(
        "Responses compact endpoint skipped: history does not end with an assistant message; " +
          "using client compaction",
      );
      return undefined;
    }
    if (requiresCompactionReplayRefresh(messages, params.model, params.requestOptions)) {
      // The exact old window is gone. Only the durable full-history client
      // compactor can rebuild it; recent-turn endpoint input cannot.
      log.warn(
        "Responses compact endpoint skipped: the stored checkpoint needs a full-history rebuild; " +
          "using client compaction",
      );
      return undefined;
    }
    // Retained windows must already contain canonical image payloads.
    const windowSource = findEndpointWindowNormalizationSource(params);
    if (windowSource) {
      log.warn(
        `Responses compact endpoint skipped: its ${windowSource} would require image ` +
          "normalization in the stored window; using client compaction",
      );
      return undefined;
    }
    const owner = params.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (!owner || owner.type !== "message" || owner.message.role !== "assistant") {
      throw new Error("Responses compact endpoint requires a persisted assistant owner");
    }
    const compacted = await compactWithSafetyTimeout(
      (signal) =>
        requestPreparedOpenAIResponsesCompaction(
          params.streamFn,
          params.model,
          { systemPrompt: params.context.systemPrompt, messages },
          { ...params.requestOptions, signal },
        ),
      params.requestOptions.timeoutMs,
      params.requestOptions.signal ? { abortSignal: params.requestOptions.signal } : undefined,
    );
    params.onUsage?.(compacted.usage);
    params.assertActive?.();
    const replacement = structuredClone(owner.message);
    captureOpenAIResponsesCompaction(
      replacement,
      compacted.item,
      compacted.historyMode === "retained-users" ? "retained-users" : replacement.content.length,
      compacted.model,
      compacted.replayMetadata,
      compacted.output,
    );
    if (params.trigger === "budget" && params.requestBudget) {
      const budget = params.requestBudget;
      // The checkpoint owns its entire returned window, including retained users.
      // Foreground fixed costs already include the otherwise empty prompt boundary.
      const replacementTokens =
        estimateLlmBoundaryTokenPressure({
          messages: [replacement],
          prompt: "",
          replay: {
            model: params.model,
            sessionId: params.requestOptions.sessionId,
            authProfileId: params.requestOptions.authProfileId,
          },
        }) - estimateRenderedLlmBoundaryTokenPressure({ prompt: "" });
      if (
        replacementTokens + budget.fixedTokens + budget.pendingTokens >
        budget.contextWindow - budget.reserveTokens
      ) {
        log.warn(
          "Responses compact endpoint result discarded: returned window does not fit the " +
            `request budget (windowTokens=${replacementTokens}); using client compaction`,
        );
        return undefined;
      }
    }
    const normalized = sanitizeTranscriptMessage(replacement);
    if (
      normalized.role !== "assistant" ||
      !isDeepStrictEqual(normalized.providerReplay, replacement.providerReplay)
    ) {
      throw new Error("Responses compact endpoint window requires image normalization");
    }
    await withSessionManagerWrite(params.sessionManager, async () => {
      params.requestOptions.signal?.throwIfAborted();
      params.assertActive?.();
      const rewritten = await rewriteTranscriptEntriesInSessionManager({
        sessionManager: params.sessionManager,
        replacements: [{ entryId: owner.id, message: normalized }],
        preserveReplacementCompactionReplay: true,
      });
      if (
        replacement.providerReplay?.data !== compacted.item.encrypted_content ||
        !rewritten.changed
      ) {
        throw new Error(
          `Responses compact endpoint checkpoint was not persisted: ${rewritten.reason}`,
        );
      }
      compactionCommitted = true;
      params.onCompactionCommitted?.(compacted.usage.input_tokens);
    });
    return compacted;
  } catch (err) {
    // Observer or handle-release failures after commit must not trigger a
    // second client compaction of the already replaced context.
    if (compactionCommitted) {
      throw err;
    }
    params.assertActive?.();
    log.warn(
      `Responses compact endpoint failed; falling back to client compaction: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

/** Name the first request source the endpoint may retain that image normalization would rewrite. */
function findEndpointWindowNormalizationSource(params: {
  model: Parameters<typeof supportsNativeOpenAIResponsesEndpoint>[0];
  context: { systemPrompt: string; messages: readonly AgentMessage[] };
  config?: OpenClawConfig;
}): "system prompt" | "user message" | undefined {
  // Public OpenAI receives the prompt as `instructions`; other compact routes put it in input.
  if (params.context.systemPrompt && !supportsNativeOpenAIResponsesEndpoint(params.model)) {
    const prompt: AgentMessage = {
      role: "user",
      content: params.context.systemPrompt,
      timestamp: 0,
    };
    if (sanitizeTranscriptMessage(prompt) !== prompt) {
      return "system prompt";
    }
  }
  return params.context.messages.some(
    (message) => message.role === "user" && sanitizeTranscriptMessage(message) !== message,
  )
    ? "user message"
    : undefined;
}
