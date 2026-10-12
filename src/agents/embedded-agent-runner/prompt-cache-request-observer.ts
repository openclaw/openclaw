import type { AssistantMessage } from "../../llm/types.js";
import type { StreamFn } from "../runtime/index.js";
import type { NormalizedUsage } from "../usage.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  type PromptCacheChange,
} from "./prompt-cache-observability.js";
import type { ProviderPromptState } from "./provider-prompt-state.js";

type PromptCacheObservationStart = ReturnType<typeof beginPromptCacheObservation> & {
  requestIndex: number;
  messageCount: number;
};
type PromptCacheSnapshot = PromptCacheObservationStart["snapshot"];

export type MeasuredRequestContext = {
  requestIndex: number;
  messageCount: number;
  contextTokens: number;
  responseId?: string;
  turnId?: string;
};

export type PromptCacheRequestObservation = {
  requestIndex: number;
  messageCount: number;
  broke: boolean;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  previousCacheRead?: number;
  requestGapMs?: number;
  providerPrefix?: string;
  dropCause?: string;
  promptTokens?: number;
  changes: PromptCacheChange[] | null;
  requests?: {
    previous?: NonNullable<ProviderPromptState["lastAttempt"]>["wire"];
    current?: NonNullable<ProviderPromptState["lastAttempt"]>["wire"];
  };
};

/** Pairs foreground request inputs with completion usage before billing aggregation. */
export function createPromptCacheRequestObserver(
  params: Omit<
    Parameters<typeof beginPromptCacheObservation>[0],
    "provider" | "modelId" | "modelApi" | "systemPrompt" | "tools" | "messages"
  >,
  onObservation: (
    observation: PromptCacheRequestObservation,
    snapshot: PromptCacheSnapshot,
  ) => void,
  onRequest?: (request: PromptCacheObservationStart) => void,
) {
  let requestIndex = 0;
  let request: PromptCacheObservationStart | undefined;
  let observation: PromptCacheRequestObservation | undefined;
  let contextUsage: MeasuredRequestContext | undefined;
  return {
    onModelRequest: (
      model: Pick<Parameters<StreamFn>[0], "provider" | "id" | "api">,
      context: Pick<Parameters<StreamFn>[1], "systemPrompt" | "tools" | "messages">,
    ) => {
      if (request) {
        completePromptCacheObservation(params);
      }
      requestIndex += 1;
      request = {
        ...beginPromptCacheObservation({
          ...params,
          provider: model.provider,
          modelId: model.id,
          modelApi: model.api,
          systemPrompt: context.systemPrompt ?? "",
          tools: collectPromptCacheTools(context.tools ?? []),
          messages: context.messages,
        }),
        requestIndex,
        messageCount: context.messages.length,
      };
      onRequest?.(request);
      return request;
    },
    onModelUsage: (
      usage: NormalizedUsage | undefined,
      providerPrompt?: ProviderPromptState["lastAttempt"],
      identity?: Pick<AssistantMessage, "responseId" | "turnId">,
    ) => {
      if (!request) {
        return;
      }
      const cacheBreak = completePromptCacheObservation({ ...params, usage, providerPrompt });
      const providerPrefix = cacheBreak?.providerPrefix;
      const dropCause = !cacheBreak
        ? undefined
        : cacheBreak.changes?.length
          ? "tracked-input-change"
          : !providerPrefix || providerPrefix === "unavailable"
            ? "unattributed:provider-prompt-unavailable"
            : providerPrefix === "prefix-match"
              ? "provider-cache-reuse-lost:unchanged-prefix"
              : providerPrefix.startsWith("continuation:")
                ? "unattributed:continuation-wire-input"
                : providerPrefix.startsWith("unverified-after:")
                  ? "unattributed:bounded-prefix"
                  : `provider-input-change:${providerPrefix}`;
      const hasCacheTelemetry = usage?.cacheTelemetry?.state !== "unavailable";
      // Keep completion identity private; cache diagnostics need only aggregate usage.
      contextUsage =
        usage?.contextUsage?.state === "available"
          ? {
              requestIndex: request.requestIndex,
              messageCount: request.messageCount,
              contextTokens: usage.contextUsage.totalTokens,
              responseId: identity?.responseId?.trim() || undefined,
              turnId: identity?.turnId?.trim() || undefined,
            }
          : undefined;
      observation = {
        requestIndex: request.requestIndex,
        messageCount: request.messageCount,
        broke: Boolean(cacheBreak),
        previousCacheRead: request.previousCacheRead ?? undefined,
        requestGapMs: request.requestGapMs,
        providerPrefix,
        dropCause,
        requests: cacheBreak?.requests,
        promptTokens:
          usage?.contextUsage?.state === "available" ? usage.contextUsage.promptTokens : undefined,
        input: usage?.input,
        cacheRead: hasCacheTelemetry ? usage?.cacheRead : undefined,
        cacheWrite: hasCacheTelemetry ? usage?.cacheWrite : undefined,
        changes: cacheBreak?.changes ?? request.changes,
      };
      const { snapshot } = request;
      request = undefined;
      onObservation(observation, snapshot);
    },
    getObservation: () => observation,
    getContextUsage: () => contextUsage,
  };
}
