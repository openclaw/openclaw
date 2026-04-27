import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import type { AnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import type { CacheTrace } from "../../cache-trace.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
} from "../../pi-embedded-helpers.js";
import {
  shouldAllowProviderOwnedThinkingReplay,
  type TranscriptPolicy,
} from "../../transcript-policy.js";
import { dropReasoningFromHistory, dropThinkingBlocks } from "../thinking.js";
import { createYieldAbortedResponse } from "./attempt.sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  sanitizeReplayToolCallIdsForStream,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptStreamWrapperSession = {
  agent: {
    streamFn: StreamFn;
  };
};

function wrapStreamFnDropThinkingBlocks(
  streamFn: StreamFn,
  options: { dropThinkingBlocks: boolean; dropReasoningFromHistory: boolean },
): StreamFn {
  return (model, context, opts) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return streamFn(model, context, opts);
    }
    const reasoningSanitized = options.dropReasoningFromHistory
      ? dropReasoningFromHistory(messages as unknown as AgentMessage[])
      : (messages as unknown as AgentMessage[]);
    const sanitized = options.dropThinkingBlocks
      ? (dropThinkingBlocks(reasoningSanitized) as unknown)
      : (reasoningSanitized as unknown);
    if (sanitized === messages) {
      return streamFn(model, context, opts);
    }
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: sanitized,
    } as unknown;
    return streamFn(model, nextContext as typeof context, opts);
  };
}

function wrapStreamFnSanitizeReplayToolCallIds(params: {
  streamFn: StreamFn;
  transcriptPolicy: TranscriptPolicy;
  allowedToolNames: Set<string>;
}): StreamFn {
  const mode = params.transcriptPolicy.toolCallIdMode;
  if (!mode) {
    return params.streamFn;
  }
  return (model, context, options) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return params.streamFn(model, context, options);
    }
    const nextMessages = sanitizeReplayToolCallIdsForStream({
      messages: messages as AgentMessage[],
      mode,
      allowedToolNames: params.allowedToolNames,
      preserveNativeAnthropicToolUseIds: params.transcriptPolicy.preserveNativeAnthropicToolUseIds,
      preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
        modelApi: (model as { api?: unknown })?.api as string | null | undefined,
        policy: params.transcriptPolicy,
      }),
      repairToolUseResultPairing: params.transcriptPolicy.repairToolUseResultPairing,
    });
    if (nextMessages === messages) {
      return params.streamFn(model, context, options);
    }
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: nextMessages,
    } as unknown;
    return params.streamFn(model, nextContext as typeof context, options);
  };
}

function wrapStreamFnDowngradeOpenAIResponses(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    const ctx = context as unknown as { messages?: unknown };
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) {
      return streamFn(model, context, options);
    }
    // Strip orphaned reasoning blocks first, then fix function-call pairing; this
    // mirrors the OpenAI provider conversion order.
    const reasoningSanitized = downgradeOpenAIReasoningBlocks(messages as AgentMessage[]);
    const sanitized = downgradeOpenAIFunctionCallReasoningPairs(reasoningSanitized);
    if (sanitized === messages) {
      return streamFn(model, context, options);
    }
    const nextContext = {
      ...(context as unknown as Record<string, unknown>),
      messages: sanitized,
    } as unknown;
    return streamFn(model, nextContext as typeof context, options);
  };
}

function wrapStreamFnYieldAbort(params: {
  streamFn: StreamFn;
  shouldReturnYieldAbortedResponse: () => boolean;
}): StreamFn {
  return (model, context, options) => {
    if (params.shouldReturnYieldAbortedResponse()) {
      return createYieldAbortedResponse(model) as unknown as Awaited<
        ReturnType<typeof params.streamFn>
      >;
    }
    return params.streamFn(model, context, options);
  };
}

export function applyAttemptStreamWrappers(params: {
  activeSession: AttemptStreamWrapperSession;
  cacheTrace: CacheTrace | null;
  transcriptPolicy: TranscriptPolicy;
  allowedToolNames: Set<string>;
  isOpenAIResponsesApi: boolean;
  unknownToolThreshold: number;
  provider: string;
  model: EmbeddedRunAttemptParams["model"];
  anthropicPayloadLogger: AnthropicPayloadLogger | null;
  shouldReturnYieldAbortedResponse: () => boolean;
}): void {
  if (params.cacheTrace) {
    params.activeSession.agent.streamFn = params.cacheTrace.wrapStreamFn(
      params.activeSession.agent.streamFn,
    );
  }

  if (
    params.transcriptPolicy.dropThinkingBlocks ||
    params.transcriptPolicy.dropReasoningFromHistory
  ) {
    params.activeSession.agent.streamFn = wrapStreamFnDropThinkingBlocks(
      params.activeSession.agent.streamFn,
      {
        dropThinkingBlocks: params.transcriptPolicy.dropThinkingBlocks ?? false,
        dropReasoningFromHistory: params.transcriptPolicy.dropReasoningFromHistory ?? false,
      },
    );
  }

  if (
    params.transcriptPolicy.sanitizeToolCallIds &&
    params.transcriptPolicy.toolCallIdMode &&
    !params.isOpenAIResponsesApi
  ) {
    params.activeSession.agent.streamFn = wrapStreamFnSanitizeReplayToolCallIds({
      streamFn: params.activeSession.agent.streamFn,
      transcriptPolicy: params.transcriptPolicy,
      allowedToolNames: params.allowedToolNames,
    });
  }

  if (params.isOpenAIResponsesApi) {
    params.activeSession.agent.streamFn = wrapStreamFnDowngradeOpenAIResponses(
      params.activeSession.agent.streamFn,
    );
  }

  params.activeSession.agent.streamFn = wrapStreamFnYieldAbort({
    streamFn: params.activeSession.agent.streamFn,
    shouldReturnYieldAbortedResponse: params.shouldReturnYieldAbortedResponse,
  });

  params.activeSession.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
    params.activeSession.agent.streamFn,
    params.allowedToolNames,
    params.transcriptPolicy,
  );
  params.activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
    params.activeSession.agent.streamFn,
    params.allowedToolNames,
    {
      unknownToolThreshold: params.unknownToolThreshold,
    },
  );

  if (
    shouldRepairMalformedToolCallArguments({
      provider: params.provider,
      modelApi: params.model.api,
    })
  ) {
    params.activeSession.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(
      params.activeSession.agent.streamFn,
    );
  }

  if (resolveToolCallArgumentsEncoding(params.model) === "html-entities") {
    params.activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
      params.activeSession.agent.streamFn,
    );
  }

  if (params.anthropicPayloadLogger) {
    params.activeSession.agent.streamFn = params.anthropicPayloadLogger.wrapStreamFn(
      params.activeSession.agent.streamFn,
    );
  }

  params.activeSession.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(
    params.activeSession.agent.streamFn,
  );
}
