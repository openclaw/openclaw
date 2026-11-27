import { isDeepStrictEqual } from "node:util";
import { resolveCompactionThreshold } from "@openclaw/ai/internal/shared";
import {
  captureOpenAIResponsesCompaction,
  requestPreparedOpenAIResponsesCompaction,
  resolveCompletionTokenReservation,
  usesNativeOpenAICodexResponsesBackend,
} from "@openclaw/ai/transports";
import {
  hasRuntimeContextMarker,
  type AssistantHistoryMessage,
  type Context,
  type Model,
} from "@openclaw/llm-core";
import { extractSummaryText } from "../../../../packages/agent-core/src/harness/compaction/utils.js";
import { consumeAgentCoreStream } from "../../../../packages/agent-core/src/runtime-deps.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { decideContextPressure, deferBoundaryMaintenanceOnce } from "../../context-pressure.js";
import type { StreamFn } from "../../runtime/index.js";
import { getRawSessionAppendMessageAsync } from "../../session-raw-append-message.js";
import {
  agentSessionRunProviderCompaction,
  agentSessionRunWarmCompaction,
} from "../../sessions/agent-session-types.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SAFETY_MARGIN } from "../../sessions/context-token-pressure.js";
import type { FixedRequestTokenPressure } from "../../sessions/context-token-pressure.js";
import { SessionTranscriptMessageCommittedError } from "../../sessions/session-manager-message-error.js";
import { withSessionManagerWriteAssertion } from "../../sessions/session-manager-write-admission.js";
import { recordSessionModelUsage } from "../../sessions/session-model-usage.js";
import { sanitizeTranscriptMessage } from "../../transcript-sanitize.js";
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

/**
 * How the request boundary compacts: the native ChatGPT checkpoint, or a warm text
 * summary sent as the session's next request plus one summarize instruction.
 */
export type RequestBoundaryCompaction = "native-checkpoint" | "text";

/**
 * The boundary compacts sessions whose summary may come from the session's own
 * model and history. Context engines, registered providers, a separate
 * compaction model and memory-flush runs keep their own compaction owners.
 */
export function requestBoundaryOwnsCompaction(params: {
  config?: OpenClawConfig;
  compactionEnabled: boolean;
  contextEngineOwnsCompaction?: boolean;
  operation?: string;
  trigger?: string;
}): boolean {
  return (
    params.compactionEnabled &&
    !params.contextEngineOwnsCompaction &&
    !params.config?.agents?.defaults?.compaction?.model?.trim() &&
    !params.config?.agents?.defaults?.compaction?.provider &&
    params.operation !== "settled-tool-finalization" &&
    params.trigger !== "memory"
  );
}

/** Capability, not provider identity, selects the native checkpoint variant. */
export function resolveRequestBoundaryCompaction(
  params: Parameters<typeof requestBoundaryOwnsCompaction>[0] & {
    model: Pick<Model, "api" | "provider" | "baseUrl">;
    extraParams: Record<string, unknown>;
    compactionReplayEnabled: boolean;
  },
): RequestBoundaryCompaction | undefined {
  if (!requestBoundaryOwnsCompaction(params)) {
    return undefined;
  }
  return params.compactionReplayEnabled &&
    params.extraParams.responsesCompactEndpoint !== false &&
    params.extraParams.responsesServerCompaction !== false &&
    usesNativeOpenAICodexResponsesBackend(params.model)
    ? "native-checkpoint"
    : "text";
}

/** One attempt-local boundary, called only after the normal prompt projections have settled. */
export function createRequestBoundaryCompaction(params: {
  variant: RequestBoundaryCompaction;
  session: AgentSession;
  config?: OpenClawConfig;
  contextTokenBudget: number;
  reserveTokens: number;
  maxOutputTokens?: number;
  runId?: string;
  /** Soft fallbacks and text commits may stop only where the tool batch can continue. */
  isToolBoundarySafe?: () => boolean;
  timeoutMs: number;
  authProfileId?: string;
  assertActive: () => void;
  withTranscriptWrite: <T>(write: () => Promise<T>) => Promise<T>;
  /** Receives the precheck request that ends this attempt for the run's recovery. */
  onPrecheck: (request: MidTurnPrecheckRequest) => void;
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
  fixedTokenPressure?: FixedRequestTokenPressure,
) => Promise<AssistantHistoryMessage | undefined> {
  let failed = false;
  return async (streamFn, model, context, options, requestAnchor, fixedTokenPressure) => {
    if (params.session.isCompacting) {
      return undefined;
    }
    const native =
      params.variant === "native-checkpoint" && usesNativeOpenAICodexResponsesBackend(model);
    const label = native ? "ChatGPT V2" : "Warm request";
    const requestOptions = { ...options, authProfileId: params.authProfileId };
    const assertActive = () => {
      requestOptions.signal?.throwIfAborted();
      params.assertActive();
    };
    assertActive();
    const budget = {
      fixedTokenPressure,
      contextTokenBudget: params.contextTokenBudget,
      reserveTokens: params.reserveTokens,
      replay: {
        model,
        sessionId: requestOptions.sessionId,
      },
    };
    // Price hard admission from the projected request, not maintenance headroom.
    const outgoing = resolveProjectedRequestPressure({
      ...budget,
      context,
      previousRequest: requestAnchor,
    });
    // Saved usage and preflight's margin can still request early maintenance.
    const preflight = requestAnchor
      ? undefined
      : shouldPreemptivelyCompactBeforePrompt({
          ...budget,
          messages: context.messages,
          systemPrompt: context.systemPrompt,
          prompt: "",
          toolSchemaTokens: fixedTokenPressure
            ? Math.ceil(fixedTokenPressure.toolTokens * SAFETY_MARGIN)
            : estimateToolSchemaTokenPressure(context.tools),
        });
    const maintenance = preflight ? (preflight.compactionReplay ?? preflight) : outgoing;
    // The boundary sends the complete window plus its summary request. It starts at
    // the client threshold ratio, capped by the reserve-based prompt budget, so every
    // route compacts at the same occupancy and the summary request keeps headroom.
    const contextTokens = Math.min(
      params.contextTokenBudget,
      model.contextWindow ?? params.contextTokenBudget,
    );
    const softTriggerTokens = Math.min(
      outgoing.promptBudgetBeforeReserve,
      Math.max(
        1,
        resolveCompactionThreshold({ contextWindowTokens: contextTokens, reserveTokensFloor: 0 }),
      ),
    );
    const conservativeInputTokens = Math.max(
      outgoing.estimatedPromptTokens,
      maintenance.estimatedPromptTokens,
    );
    if (conservativeInputTokens < softTriggerTokens) {
      return undefined;
    }
    const maxOutputTokens = resolveCompletionTokenReservation(
      model,
      options?.thinkingBudgets
        ? model.maxTokens
        : (options?.maxTokens ?? params.maxOutputTokens ?? model.maxTokens),
      options?.reasoning,
    );
    if (
      !failed &&
      context.messages.findLast((message) => !hasRuntimeContextMarker(message))?.role ===
        "toolResult" &&
      params.session.agent.state.pendingToolCalls.size === 0 &&
      params.isToolBoundarySafe?.() === true &&
      maxOutputTokens > 0 &&
      conservativeInputTokens + maxOutputTokens <= contextTokens &&
      deferBoundaryMaintenanceOnce(params.runId)
    ) {
      return undefined;
    }
    const fallback = (reason: string) => {
      // The V2 trigger must not move the client's compaction threshold, and a
      // soft fallback waits for a boundary where the tool batch can continue. The
      // text variant replaces the client threshold, so its maintenance is due.
      const maintenanceDue = !native || maintenance.route !== "fits";
      const pressure = decideContextPressure({
        estimatedPromptTokens: outgoing.estimatedPromptTokens,
        windowTokens: model.contextWindow ?? params.contextTokenBudget,
        maintenanceDue,
        boundarySafe: maintenanceDue && (params.isToolBoundarySafe?.() ?? false),
        runId: params.runId,
      });
      if (!pressure) {
        return undefined;
      }
      log.warn(`${label} compaction unavailable; falling back to client compaction: ${reason}`);
      const request: MidTurnPrecheckRequest = {
        ...outgoing,
        pressure,
        // V2 exhausted this boundary. Route to the existing durable client compactor.
        route: "compact_only",
      };
      params.onPrecheck(request);
      throw new MidTurnPrecheckSignal(request);
    };
    if (outgoing.estimatedPromptTokens > (model.contextWindow ?? params.contextTokenBudget)) {
      return fallback("the outgoing request exceeds the model context window");
    }
    if (failed) {
      return fallback(`an earlier ${label} attempt in this run failed`);
    }
    if (params.session.agent.state.pendingToolCalls.size > 0) {
      return fallback("tool calls are still pending");
    }
    if (!native) {
      // A commit ends this attempt so its retry starts from the compacted transcript.
      // The shared pressure owner allows that only at a settled tool boundary and
      // not after this run declined maintenance that could not reduce context.
      const pressure = decideContextPressure({
        estimatedPromptTokens: outgoing.estimatedPromptTokens,
        windowTokens: model.contextWindow ?? params.contextTokenBudget,
        maintenanceDue: true,
        boundarySafe: params.isToolBoundarySafe?.() ?? false,
        runId: params.runId,
      });
      if (pressure !== "maintenance") {
        return undefined;
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
      let failure = "compaction did not complete";
      const compacted = await params.session[agentSessionRunWarmCompaction](
        async (instructions, signal) => {
          try {
            const response = await compactWithSafetyTimeout(
              (timeoutSignal) =>
                // The unchanged request plus one instruction reads the warm prompt cache;
                // the instruction is never replayed, so it takes no cache checkpoint.
                consumeAgentCoreStream(
                  streamFn(
                    model,
                    {
                      ...context,
                      messages: [
                        ...context.messages,
                        {
                          role: "user",
                          content: [{ type: "text", text: instructions }],
                          timestamp: Date.now(),
                          cacheCheckpoint: false,
                        },
                      ],
                    },
                    { ...requestOptions, signal: timeoutSignal },
                  ),
                ),
              params.timeoutMs,
              {
                abortSignal: requestOptions.signal
                  ? AbortSignal.any([signal, requestOptions.signal])
                  : signal,
              },
            );
            recordSessionModelUsage(params.session.sessionManager, response.usage);
            const summary =
              response.stopReason === "stop" &&
              !response.content.some((block) => block.type === "toolCall")
                ? extractSummaryText(response)
                : undefined;
            if (summary === undefined) {
              throw new Error(
                `the reply ended with ${response.stopReason} and no usable summary${
                  response.errorMessage ? `: ${response.errorMessage}` : ""
                }`,
              );
            }
            return summary;
          } catch (error) {
            failure = formatErrorMessage(error);
            throw error;
          }
        },
        Boolean(params.hookContext),
      );
      assertActive();
      if (!compacted) {
        failed = true;
        return fallback(failure);
      }
      if (params.postCompaction) {
        await hooks!.runPostCompactionSideEffects({ ...params.postCompaction, assertActive });
      }
      if (params.hookContext) {
        await hooks!.runCompactionHooks({
          ...params.hookContext,
          assertActive,
          phase: "after",
          messageCountAfter: params.session.agent.state.messages.length,
          tokensAfter: compacted.tokensAfter,
          compactedCount: context.messages.length,
          tokensBefore: compacted.result.tokensBefore,
          firstKeptEntryId: compacted.result.firstKeptEntryId,
          summaryLength: compacted.result.summary.length,
          sessionFile: params.session.sessionFile ?? "",
        });
      }
      // The loop still holds the uncompacted context. Stop at this settled boundary;
      // the run continues from the compacted transcript without compacting again.
      const request: MidTurnPrecheckRequest = {
        ...outgoing,
        pressure: "maintenance",
        route: "compact_only",
      };
      params.onPrecheck(request);
      throw new MidTurnPrecheckSignal(request);
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
          const prepared = sanitizeTranscriptMessage(message);
          if (prepared.role !== "user" || !isDeepStrictEqual(prepared.content, message.content)) {
            throw new Error("ChatGPT V2 retained input requires transcript normalization");
          }
        } else if (message.role === "assistant" && message.providerReplay) {
          const prepared = sanitizeTranscriptMessage(message);
          if (
            prepared.role !== "assistant" ||
            !isDeepStrictEqual(prepared.providerReplay, message.providerReplay)
          ) {
            throw new Error("ChatGPT V2 prior checkpoint requires transcript normalization");
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
                    const checkpoint: AssistantHistoryMessage = {
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
                      toolSchemaTokens: fixedTokenPressure
                        ? Math.ceil(fixedTokenPressure.toolTokens * SAFETY_MARGIN)
                        : estimateToolSchemaTokenPressure(context.tools),
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
          const checkpoint: AssistantHistoryMessage = {
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
            toolSchemaTokens: fixedTokenPressure
              ? Math.ceil(fixedTokenPressure.toolTokens * SAFETY_MARGIN)
              : estimateToolSchemaTokenPressure(context.tools),
            replay: {
              model,
              sessionId: requestOptions.sessionId,
            },
          });
          if (tokensAfter > outgoing.promptBudgetBeforeReserve) {
            throw new Error("ChatGPT V2 checkpoint exceeds the next request budget");
          }
          const prepared = sanitizeTranscriptMessage(checkpoint);
          if (
            prepared.role !== "assistant" ||
            !isDeepStrictEqual(prepared.providerReplay, checkpoint.providerReplay)
          ) {
            throw new Error("ChatGPT V2 checkpoint requires transcript normalization");
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
              const entryId = await getRawSessionAppendMessageAsync(manager)(prepared);
              if (!entryId) {
                throw new Error("ChatGPT V2 checkpoint was not persisted");
              }
              committed = true;
              params.session.agent.state.messages.push(prepared);
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
          return prepared;
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
