import { isDeepStrictEqual } from "node:util";
import {
  captureOpenAIResponsesCompaction,
  requestPreparedOpenAIResponsesCompaction,
  usesNativeOpenAICodexResponsesBackend,
} from "@openclaw/ai/transports";
import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { StreamFn } from "../../runtime/index.js";
import { getRawSessionAppendMessageAsync } from "../../session-raw-append-message.js";
import { agentSessionRunProviderCompaction } from "../../sessions/agent-session-types.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionTranscriptMessageCommittedError } from "../../sessions/session-manager-message-error.js";
import { withSessionManagerWriteAssertion } from "../../sessions/session-manager-write-admission.js";
import { recordSessionModelUsage } from "../../sessions/session-model-usage.js";
import { redactTranscriptMessage } from "../../transcript-redact.js";
import { makeZeroUsageSnapshot, normalizeUsage } from "../../usage.js";
import type { runCompactionHooks, runPostCompactionSideEffects } from "../compaction-hooks.js";
import { compactWithSafetyTimeout } from "../compaction-safety-timeout.js";
import { log } from "../logger.js";
import type { MeasuredRequestContext } from "../prompt-cache-request-observer.js";
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import {
  estimateLlmBoundaryTokenPressure,
  estimateToolSchemaTokenPressure,
  resolveProjectedRequestPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

/** Only the native ChatGPT request path owns V2; proxies keep their existing policy. */
export function isChatGPTV2CompactionEligible(params: {
  config?: OpenClawConfig;
  model: Pick<Model, "api" | "provider" | "baseUrl">;
  extraParams: Record<string, unknown>;
  compactionEnabled: boolean;
  compactionReplayEnabled: boolean;
  contextEngineOwnsCompaction?: boolean;
  operation?: string;
}): boolean {
  return (
    params.compactionEnabled &&
    params.compactionReplayEnabled &&
    !params.contextEngineOwnsCompaction &&
    !params.config?.agents?.defaults?.compaction?.model?.trim() &&
    !params.config?.agents?.defaults?.compaction?.provider &&
    params.operation !== "settled-tool-finalization" &&
    params.extraParams.responsesCompactEndpoint !== false &&
    params.extraParams.responsesServerCompaction !== false &&
    usesNativeOpenAICodexResponsesBackend(params.model)
  );
}

/** One attempt-local boundary, called only after the normal prompt projections have settled. */
export function createChatGPTV2CompactionBoundary(params: {
  session: AgentSession;
  config?: OpenClawConfig;
  contextTokenBudget: number;
  reserveTokens: number;
  timeoutMs: number;
  authProfileId?: string;
  assertActive: () => void;
  withTranscriptWrite: <T>(write: () => Promise<T>) => Promise<T>;
  onFallback: (request: MidTurnPrecheckRequest) => void;
  hookContext?: Pick<
    Parameters<typeof runCompactionHooks>[0],
    | "sessionId"
    | "sessionKey"
    | "sessionAgentId"
    | "workspaceDir"
    | "messageProvider"
    | "hookRunner"
    | "onHookMessages"
  >;
  postCompaction?: Omit<Parameters<typeof runPostCompactionSideEffects>[0], "assertActive">;
}): (
  streamFn: StreamFn,
  model: Model,
  context: Context,
  options: Parameters<StreamFn>[2],
  requestAnchor?: MeasuredRequestContext,
) => Promise<AssistantMessage | undefined> {
  let failed = false;
  return async (streamFn, model, context, options, requestAnchor) => {
    if (!usesNativeOpenAICodexResponsesBackend(model) || params.session.isCompacting) {
      return undefined;
    }
    const requestOptions = { ...options, authProfileId: params.authProfileId };
    const assertActive = () => {
      requestOptions.signal?.throwIfAborted();
      params.assertActive();
    };
    assertActive();
    const budget = {
      contextTokenBudget: params.contextTokenBudget,
      reserveTokens: params.reserveTokens,
      replay: {
        model,
        sessionId: requestOptions.sessionId,
        authProfileId: requestOptions.authProfileId,
      },
    };
    // A matching measured predecessor prices the unchanged prefix once, as the
    // mid-turn precheck this boundary replaces does. Without one, keep the
    // conservative preflight estimate, which honors persisted session usage.
    const preflight = requestAnchor
      ? undefined
      : shouldPreemptivelyCompactBeforePrompt({
          ...budget,
          messages: context.messages,
          systemPrompt: context.systemPrompt,
          prompt: "",
          toolSchemaTokens: estimateToolSchemaTokenPressure(context.tools),
        });
    const outgoing = preflight
      ? (preflight.compactionReplay ?? preflight)
      : resolveProjectedRequestPressure({ ...budget, context, previousRequest: requestAnchor });
    if (outgoing.route === "fits") {
      return undefined;
    }
    const fallback = (reason: string) => {
      log.warn(`ChatGPT V2 compaction unavailable; falling back to client compaction: ${reason}`);
      const request: MidTurnPrecheckRequest = {
        ...outgoing,
        // V2 exhausted this boundary. Route to the existing durable client compactor.
        route: "compact_only",
      };
      params.onFallback(request);
      throw new MidTurnPrecheckSignal(request);
    };
    if (failed) {
      return fallback("an earlier V2 attempt in this run failed");
    }
    if (params.session.agent.state.pendingToolCalls.size > 0) {
      return fallback("tool calls are still pending");
    }
    if (outgoing.estimatedPromptTokens > (model.contextWindow ?? params.contextTokenBudget)) {
      return fallback("the outgoing request exceeds the model context window");
    }
    const manager = params.session.sessionManager;
    const coveredLeaf = manager.getLeafId();
    let committed = false;
    let persistenceStarted = false;
    let providerSignal: AbortSignal | undefined;
    try {
      // V2 retains source-authored user text and any prior complete window.
      // Reject known persistence incompatibilities before spending a model call.
      for (const message of context.messages) {
        if (
          message.role === "user" &&
          !message.synthetic &&
          !message.operatorMessage &&
          !message.runtimeContextCarrier &&
          !message.runtimeContext
        ) {
          const redacted = redactTranscriptMessage(message, params.config);
          if (redacted.role !== "user" || !isDeepStrictEqual(redacted.content, message.content)) {
            throw new Error("ChatGPT V2 retained input requires transcript redaction");
          }
        } else if (message.role === "assistant" && message.providerReplay) {
          const redacted = redactTranscriptMessage(message, params.config);
          if (
            redacted.role !== "assistant" ||
            !isDeepStrictEqual(redacted.providerReplay, message.providerReplay)
          ) {
            throw new Error("ChatGPT V2 prior checkpoint requires transcript redaction");
          }
        }
      }
      const hooks =
        params.hookContext || params.postCompaction
          ? await import("../compaction-hooks.js")
          : undefined;
      if (params.hookContext) {
        await hooks!.runCompactionHooks({
          ...params.hookContext,
          assertActive,
          phase: "before",
          metrics: {
            messageCountOriginal: context.messages.length,
            messageCountBefore: context.messages.length,
            tokenCountOriginal: outgoing.estimatedPromptTokens,
            tokenCountBefore: outgoing.estimatedPromptTokens,
          },
        });
      }
      assertActive();
      if (manager.getLeafId() !== coveredLeaf) {
        throw new Error("Session transcript changed before ChatGPT V2 compaction");
      }
      return await params.session[agentSessionRunProviderCompaction](
        async (signal, reportCommit) => {
          providerSignal = signal;
          const compacted = await compactWithSafetyTimeout(
            (timeoutSignal) =>
              requestPreparedOpenAIResponsesCompaction(
                streamFn,
                model,
                context,
                { ...requestOptions, signal: timeoutSignal },
                "v2",
                {
                  maxTokens: outgoing.promptBudgetBeforeReserve,
                  estimateTokens: (output, outputTokens) => {
                    const checkpoint: AssistantMessage = {
                      role: "assistant",
                      content: [],
                      api: model.api,
                      provider: model.provider,
                      model: model.id,
                      stopReason: "stop",
                      usage: makeZeroUsageSnapshot(),
                      timestamp: 0,
                    };
                    const item = output.at(-1);
                    if (!item || item.type !== "compaction") {
                      throw new Error("ChatGPT V2 replay window is missing its checkpoint");
                    }
                    captureOpenAIResponsesCompaction(
                      checkpoint,
                      item,
                      "retained-users",
                      model,
                      undefined,
                      output,
                      outputTokens,
                    );
                    return estimateLlmBoundaryTokenPressure({
                      messages: [checkpoint],
                      systemPrompt: context.systemPrompt,
                      prompt: "",
                      toolSchemaTokens: estimateToolSchemaTokenPressure(context.tools),
                      replay: { model },
                    });
                  },
                },
              ),
            params.timeoutMs,
            {
              abortSignal: requestOptions.signal
                ? AbortSignal.any([signal, requestOptions.signal])
                : signal,
            },
          );
          assertActive();
          signal.throwIfAborted();
          const usage = normalizeUsage(compacted.usage);
          recordSessionModelUsage(
            manager,
            compacted.modelUsage ?? {
              ...makeZeroUsageSnapshot(),
              input: usage?.input ?? 0,
              output: usage?.output ?? 0,
              cacheRead: usage?.cacheRead ?? 0,
              cacheWrite: usage?.cacheWrite ?? 0,
              totalTokens: usage?.total ?? 0,
            },
          );
          // A separate, empty assistant owns the exact covered prefix, including the
          // pending user and settled tool outputs. Reusing an earlier assistant would
          // replay its already-covered suffix after the returned complete window.
          const checkpoint: AssistantMessage = {
            role: "assistant",
            content: [],
            api: compacted.model.api,
            provider: compacted.model.provider,
            model: compacted.model.id,
            stopReason: "stop",
            usage: makeZeroUsageSnapshot(),
            timestamp: Date.now(),
          };
          captureOpenAIResponsesCompaction(
            checkpoint,
            compacted.item,
            "retained-users",
            compacted.model,
            compacted.replayMetadata,
            compacted.output,
            compacted.usage.output_tokens,
          );
          const tokensAfter = estimateLlmBoundaryTokenPressure({
            messages: [checkpoint],
            systemPrompt: context.systemPrompt,
            prompt: "",
            toolSchemaTokens: estimateToolSchemaTokenPressure(context.tools),
            replay: {
              model,
              sessionId: requestOptions.sessionId,
              authProfileId: requestOptions.authProfileId,
            },
          });
          if (tokensAfter > outgoing.promptBudgetBeforeReserve) {
            throw new Error("ChatGPT V2 checkpoint exceeds the next request budget");
          }
          const redacted = redactTranscriptMessage(checkpoint, params.config);
          if (
            redacted.role !== "assistant" ||
            !isDeepStrictEqual(redacted.providerReplay, checkpoint.providerReplay)
          ) {
            throw new Error("ChatGPT V2 checkpoint requires transcript redaction");
          }
          const assertCommitCurrent = () => {
            assertActive();
            signal.throwIfAborted();
          };
          await params.withTranscriptWrite(() =>
            withSessionManagerWriteAssertion(manager, assertCommitCurrent, async () => {
              assertCommitCurrent();
              if (manager.getLeafId() !== coveredLeaf) {
                throw new Error("Session transcript changed during ChatGPT V2 compaction");
              }
              // A failure after append begins may have committed. Never client-compact
              // an uncertain checkpoint; the session writer owns its reconciliation.
              persistenceStarted = true;
              const entryId = await getRawSessionAppendMessageAsync(manager)(redacted);
              if (!entryId) {
                throw new Error("ChatGPT V2 checkpoint was not persisted");
              }
              committed = true;
              params.session.agent.state.messages.push(redacted);
              reportCommit(compacted.usage.input_tokens, tokensAfter);
            }),
          );
          if (params.postCompaction) {
            await hooks!.runPostCompactionSideEffects({ ...params.postCompaction, assertActive });
          }
          if (params.hookContext) {
            await hooks!.runCompactionHooks({
              ...params.hookContext,
              assertActive,
              phase: "after",
              messageCountAfter: compacted.output.length,
              tokensAfter,
              compactedCount: context.messages.length,
              tokensBefore: compacted.usage.input_tokens,
              sessionFile: params.session.sessionFile ?? "",
            });
          }
          return redacted;
        },
        Boolean(params.hookContext),
      );
    } catch (error) {
      assertActive();
      providerSignal?.throwIfAborted();
      if (
        committed ||
        persistenceStarted ||
        error instanceof SessionTranscriptMessageCommittedError
      ) {
        throw error;
      }
      failed = true;
      return fallback(`request failed: ${formatErrorMessage(error)}`);
    }
  };
}
