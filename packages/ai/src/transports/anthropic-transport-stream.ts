import type { AssistantMessageEvent, Context, StreamFn } from "@openclaw/llm-core";
/**
 * Native Anthropic Messages streaming transport.
 * Converts OpenClaw contexts/tools into Anthropic payloads, streams SSE events
 * back into runtime output blocks, and applies provider request policy.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getEnvApiKey } from "../env-api-keys.js";
import {
  type AnthropicClaudeCodeIdentity,
  applyClaudeRequestContract,
  defaultsClaudeAdaptiveThinking,
  prepareClaudeNoPrefillRequestContext,
  requiresClaudeAdaptiveThinking,
  resolveAnthropicThinkingEffort,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  usesClaudeStreamingRefusalContract,
} from "../providers/anthropic-model-contract.js";
import { ANTHROPIC_SERVER_SIDE_FALLBACKS } from "../providers/anthropic-server-fallback.js";
import { applyAnthropicThinkingBindingControls } from "../providers/anthropic-thinking-replay.js";
import {
  normalizeAnthropicToolCallId,
  type AnthropicToolProjection,
} from "../providers/anthropic-tool-projection.js";
import { adjustMaxTokensForThinking } from "../providers/simple-options.js";
import { redactDiagnosticText } from "../utils/credential-redaction.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  buildAnthropicReplayPlan,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "./anthropic-compaction-replay.js";
import {
  convertAnthropicMessages,
  convertAnthropicTools,
  buildAnthropicGenerationParams,
} from "./anthropic-messages.js";
import {
  applyAnthropicRequestCacheControl,
  buildAnthropicSystemBlocks,
  applyAnthropicContextManagementToRequest,
  isDirectAnthropicModel,
  resolveAnthropicContextManagementBetaHeader,
  resolveAnthropicCacheOptions,
} from "./anthropic-payload-policy.js";
import { consumeAnthropicStream, type AnthropicStreamBlock } from "./anthropic-stream-reducer.js";
import {
  type AnthropicTransportModel,
  type AnthropicTransportOptions,
  createAnthropicTransportClient,
  useAnthropicServerSideFallback,
  withEffectiveAnthropicBaseUrl,
} from "./anthropic-transport-client.js";
import { createAssistantOutput } from "./assistant-output.js";
import { resolveProviderEndpoint, transformTransportMessages } from "./host-policy.js";
import {
  copyProviderAcceptanceObserver,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  notifyProviderHttpResponse,
} from "./transport-stream-shared.js";
import { readResponseTextSnippet } from "./transport-utils.js";

// The Messages endpoint URL is resolved by the client module; keep it on this
// module's public surface, where callers outside the package already find it.
export { resolveAnthropicMessagesUrl } from "./anthropic-transport-client.js";

const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;
const ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS = 4_096;
const ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR = 4;

function resolveAnthropicRequestModelId(model: AnthropicTransportModel): string {
  if (isDirectAnthropicModel(model) && /^anthropic\//i.test(model.id)) {
    return model.id.replace(/^anthropic\//i, "");
  }
  return model.id;
}

const EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT = ".";

function resolvePositiveAnthropicTokenLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function resolveAnthropicMessagesMaxTokens(params: {
  modelContextWindow: number | undefined;
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
  useModelDefault?: boolean;
}): number | undefined {
  const requested = resolvePositiveAnthropicTokenLimit(params.requestedMaxTokens);
  if (requested !== undefined) {
    return requested;
  }
  const modelMax = resolvePositiveAnthropicTokenLimit(params.modelMaxTokens);
  if (modelMax !== undefined) {
    return params.useModelDefault ? modelMax : Math.min(modelMax, 32_000);
  }
  if (params.modelMaxTokens !== undefined) {
    return undefined;
  }
  // Anthropic requires max_tokens even when an optional custom-model row has no output cap.
  // Use a conservative compatibility baseline; higher model limits require explicit metadata.
  const contextWindow = resolvePositiveAnthropicTokenLimit(params.modelContextWindow);
  return contextWindow === undefined
    ? ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS
    : Math.max(
        1,
        Math.min(
          ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS,
          Math.floor(contextWindow / ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR),
        ),
      );
}

function supportsReasoningContentReplay(
  model: Pick<AnthropicTransportModel, "provider" | "baseUrl">,
): boolean {
  return resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
}

function ensureNonEmptyAnthropicMessages(messages: Array<Record<string, unknown>>) {
  return messages.length > 0
    ? messages
    : [{ role: "user", content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT }];
}

async function readAnthropicMessagesErrorBody(response: Response): Promise<unknown> {
  try {
    const text =
      (await readResponseTextSnippet(response, {
        maxBytes: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
        maxChars: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
        chunkTimeoutMs: ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(
            `Anthropic Messages error response stalled: no data received for ${chunkTimeoutMs}ms`,
          ),
      })) ?? "";
    try {
      // Keep complete JSON for structured redaction; clipping first erases useful errors.
      return JSON.parse(text);
    } catch {
      const redacted = redactDiagnosticText(text);
      return redacted.length > ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS
        ? `${truncateUtf16Safe(redacted, ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS)}…`
        : redacted;
    }
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.startsWith("Anthropic Messages error response stalled:")
    ) {
      return error.message;
    }
    return "";
  }
}

async function buildAnthropicParams(
  model: AnthropicTransportModel,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicTransportOptions | undefined,
  /** Present exactly when the request carries the Claude Code identity. */
  claudeCodeIdentity: AnthropicClaudeCodeIdentity | undefined,
): Promise<{
  params: Record<string, unknown>;
  toolProjection?: AnthropicToolProjection;
  usedCompactionReplay: boolean;
}> {
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
  const maxTokens = resolveAnthropicMessagesMaxTokens({
    modelContextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
  });
  if (maxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const { cacheControl, supportsCacheControlOnTools } = resolveAnthropicCacheOptions(
    model,
    options?.cacheRetention,
  );
  const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
    enabled: !isOAuthToken && options?.anthropicServerCompaction === true,
    authProfileId: options?.authProfileId,
    sessionId: options?.sessionId,
  });
  const cacheBreakpointOptOutMessageIndexes = new Set<number>();
  const messages = await convertAnthropicMessages(
    transformTransportMessages(replayPlan.messages, model, normalizeAnthropicToolCallId),
    model,
    isOAuthToken,
    {
      profile: "transport",
      allowReasoningContentReplay: supportsReasoningContentReplay(model),
      allowEmptySignature: model.compat?.allowEmptySignature,
      compaction: replayPlan.compaction,
      replayThinkingEnabled,
      cacheBreakpointOptOutMessageIndexes,
    },
  );
  const params: Record<string, unknown> = {
    model: resolveAnthropicRequestModelId(model),
    messages: ensureNonEmptyAnthropicMessages(messages),
    max_tokens: maxTokens,
    stream: true,
  };
  // Fable 5 and Opus 5 safety classifiers can decline benign-adjacent work.
  // Anthropic owns the per-category fallback recommendation so routing can
  // evolve without a client release.
  if (!isOAuthToken && useAnthropicServerSideFallback(model)) {
    params.fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
  }
  const system = buildAnthropicSystemBlocks(
    context.systemPrompt,
    isOAuthToken,
    cacheControl,
    claudeCodeIdentity?.billingSystemBlock,
  );
  if (system) {
    params.system = system;
  }
  const convertedTools = context.tools
    ? convertAnthropicTools(context.tools, isOAuthToken)
    : undefined;
  const toolProjection = convertedTools?.projection;
  Object.assign(
    params,
    buildAnthropicGenerationParams({
      model,
      options,
      tools: convertedTools?.tools,
      toolProjection,
      profile: "transport",
    }),
  );
  applyAnthropicRequestCacheControl(
    params,
    cacheControl,
    supportsCacheControlOnTools,
    cacheBreakpointOptOutMessageIndexes,
  );
  return { params, toolProjection, usedCompactionReplay: replayPlan.compaction !== undefined };
}

function resolveAnthropicTransportOptions(
  model: AnthropicTransportModel,
  options: AnthropicTransportOptions | undefined,
  apiKey: string,
): AnthropicTransportOptions {
  const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
    modelContextWindow: model.contextWindow,
    modelMaxTokens: model.maxTokens,
    requestedMaxTokens: options?.maxTokens,
    // Claude 5 defaults thinking on; the clamped 32k baseline starves thinking
    // plus response output, so these models keep their full catalog cap.
    useModelDefault:
      resolveClaudeSonnet5ModelIdentity(model) !== undefined ||
      resolveClaudeOpus5ModelIdentity(model) !== undefined,
  });
  if (baseMaxTokens === undefined) {
    throw new Error(
      `Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`,
    );
  }
  const reasoningModelMaxTokens =
    resolvePositiveAnthropicTokenLimit(model.maxTokens) ?? baseMaxTokens;
  const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
  const reasoning =
    options?.reasoning === "off" && mandatoryAdaptiveThinking ? "low" : options?.reasoning;
  const resolved: AnthropicTransportOptions = copyProviderAcceptanceObserver(options, {
    temperature: options?.temperature,
    stop: options?.stop,
    maxTokens: baseMaxTokens,
    signal: options?.signal,
    apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    onResponse: options?.onResponse,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
    interleavedThinking: options?.interleavedThinking,
    toolChoice: options?.toolChoice,
    thinkingBudgets: options?.thinkingBudgets,
    reasoning,
    anthropicServerCompaction: options?.anthropicServerCompaction,
    anthropicCompactThreshold: options?.anthropicCompactThreshold,
    cacheTtlPruning: options?.cacheTtlPruning,
    ...(options?.authProfileId ? { authProfileId: options.authProfileId } : {}),
  });
  if (reasoning === "off") {
    resolved.thinkingEnabled = false;
    return resolved;
  }
  if (!reasoning) {
    resolved.thinkingEnabled = defaultsClaudeAdaptiveThinking(model);
    if (resolved.thinkingEnabled) {
      resolved.effort = resolveAnthropicThinkingEffort(model, reasoning);
    }
    return resolved;
  }
  if (supportsClaudeAdaptiveThinking(model)) {
    resolved.thinkingEnabled = true;
    resolved.effort = resolveAnthropicThinkingEffort(model, reasoning);
    return resolved;
  }
  const adjusted = adjustMaxTokensForThinking(
    baseMaxTokens,
    reasoningModelMaxTokens,
    reasoning === "max" ? "high" : reasoning,
    options?.thinkingBudgets,
  );
  // Sub-minimum budgets (< 1024) resolve to thinking disabled so downstream
  // consumers (payload, replay, temperature, tool-choice) see consistent state.
  const thinkingEnabled = adjusted.thinkingBudget >= 1024;
  resolved.maxTokens = adjusted.maxTokens;
  resolved.thinkingEnabled = thinkingEnabled;
  resolved.thinkingBudgetTokens = thinkingEnabled ? adjusted.thinkingBudget : undefined;
  return resolved;
}

/** Create the stream function used by Anthropic Messages transport models. */
export function createAnthropicMessagesTransportStreamFn(): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = withEffectiveAnthropicBaseUrl(rawModel as AnthropicTransportModel);
    const options = rawOptions as AnthropicTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output = createAssistantOutput(model, "anthropic-messages");
      // Classifier refusals can invalidate partial output, so no event is safe
      // to expose until the terminal stop reason is known.
      const refusalBuffer = usesClaudeStreamingRefusalContract(model)
        ? createDeferredEventBuffer<AssistantMessageEvent>(stream)
        : undefined;
      let usedCompactionReplay = false;
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
        if (!apiKey) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
        const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
        const { client, isOAuthToken, directApiKeyBetaHeader, claudeCodeIdentity } =
          await createAnthropicTransportClient({
            model,
            context: requestContext,
            apiKey,
            options: transportOptions,
          });
        const builtParams = await buildAnthropicParams(
          model,
          requestContext,
          isOAuthToken,
          transportOptions,
          claudeCodeIdentity,
        );
        usedCompactionReplay = builtParams.usedCompactionReplay;
        let params = builtParams.params;
        applyAnthropicContextManagementToRequest(
          params,
          model,
          transportOptions,
          directApiKeyBetaHeader,
        );
        const nextParams = await transportOptions.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as Record<string, unknown>;
        }
        applyClaudeRequestContract(params, model);
        const betaHeader = resolveAnthropicContextManagementBetaHeader(
          params,
          directApiKeyBetaHeader,
        );
        const bindingHeaders =
          applyAnthropicThinkingBindingControls(params, betaHeader) ??
          (betaHeader ? { "anthropic-beta": betaHeader } : undefined);
        const { response, stream: anthropicStream } = await client.messages.stream(
          { ...params, stream: true },
          { signal: transportOptions.signal, headers: bindingHeaders },
        );
        await notifyProviderHttpResponse({ options: transportOptions, response, model });
        if (!response.ok) {
          const errorBody = await readAnthropicMessagesErrorBody(response);
          throw Object.assign(new Error(`${response.status} status code (no body)`), {
            status: response.status,
            headers: response.headers,
            errorBody,
          });
        }
        await consumeAnthropicStream({
          events: anthropicStream,
          model,
          options: transportOptions,
          output,
          stream,
          refusalBuffer,
          isOAuthToken,
          toolProjection: builtParams.toolProjection,
          profile: "transport",
        });
        finalizeTransportStream({ stream, output });
      } catch (error) {
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            if (refusalBuffer) {
              refusalBuffer.discard();
              output.content = [];
            } else {
              output.content = output.content.filter((block) => block.type !== "toolCall");
            }
            if (usedCompactionReplay && isAnthropicReplayRejection(output)) {
              suppressAnthropicCompaction(output, model, options);
            }
            for (const block of output.content) {
              delete (block as AnthropicStreamBlock).index;
            }
          },
        });
      }
    })();
    return eventStream;
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
