import type { AssistantMessageEvent, Context, Model, StreamFn } from "@openclaw/llm-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { racePromiseWithAbortSignal } from "../../../retry/src/index.js";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import {
  isAnthropicOAuthApiKey,
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "../providers/anthropic-auth-headers.js";
import {
  buildAnthropicClaudeCodeIdentity,
  prepareClaudeNoPrefillRequestContext,
  supportsClaudeAdaptiveThinking,
  usesClaudeStreamingRefusalContract,
} from "../providers/anthropic-model-contract.js";
import { redactDiagnosticText } from "../utils/credential-redaction.js";
import { createDeferredEventBuffer } from "../utils/deferred-event-buffer.js";
import {
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "./anthropic-compaction-replay.js";
import { buildAnthropicRequest, prepareAnthropicRequest } from "./anthropic-messages.js";
import {
  isDirectAnthropicModel,
  supportsAnthropicServerSideFallback,
} from "./anthropic-payload-policy.js";
import { consumeAnthropicStream, type AnthropicStreamBlock } from "./anthropic-stream-reducer.js";
import {
  resolveAnthropicTransportOptions,
  type AnthropicTransportOptions,
} from "./anthropic-transport-options.js";
import { createAssistantOutput } from "./assistant-output.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  notifyProviderHttpResponse,
} from "./transport-stream-shared.js";
import {
  createAbortError as createNamedAbortError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  readResponseTextSnippet,
  resolveModelHeaderSentinels,
} from "./transport-utils.js";

const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8 * 1024;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 10_000;
// Mirror the fetch sanitizer cap here because compatible routes such as Kimi
// bypass that layer; without a parser-local guard, partial frames grow forever.
const ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS = 16 * 1024 * 1024;
type AnthropicTransportModel = Model<"anthropic-messages">;

function isKimiAnthropicProvider(provider: string | undefined): boolean {
  return /^kimi(?:-|$)/.test(normalizeLowercaseStringOrEmpty(provider ?? ""));
}

function buildAnthropicBetaHeader(
  model: AnthropicTransportModel,
  betaFeatures: readonly string[],
  params: { oauth: boolean },
): string | undefined {
  if (!isDirectAnthropicModel(model)) {
    return undefined;
  }
  return params.oauth
    ? `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`
    : betaFeatures.join(",");
}

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Resolve the effective Anthropic API base URL from model or environment. */
function resolveAnthropicBaseUrl(baseUrl?: string): string {
  return baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
}

/** Resolve the Anthropic Messages endpoint URL for the effective base URL. */
export function resolveAnthropicMessagesUrl(baseUrl?: string): string {
  const normalized = resolveAnthropicBaseUrl(baseUrl).replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function withEffectiveAnthropicBaseUrl(model: AnthropicTransportModel): AnthropicTransportModel {
  const baseUrl = resolveAnthropicBaseUrl(model.baseUrl);
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

function createAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return createNamedAbortError(
    "Request was aborted",
    reason === undefined ? undefined : { cause: reason },
  );
}

function readAnthropicSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }

  return racePromiseWithAbortSignal(
    () =>
      reader.read().catch((error: unknown) => {
        throw toErrorObject(error, "Non-Error rejection");
      }),
    signal,
    createAbortError,
  );
}

function parseAnthropicSseEventData(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
    }
    throw error;
  }
}

function assertAnthropicSsePendingBufferWithinLimit(pendingChars: number): void {
  if (pendingChars <= ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS) {
    return;
  }
  throw new Error(
    `Anthropic Messages SSE response exceeded max pending buffer size (${ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS} chars) without event boundary`,
  );
}

async function* parseAnthropicSseBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  // CRLF must remain one line ending even when the delimiter expression backtracks.
  const delimiter = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/g;
  let scanOffset = 0;
  try {
    while (!completed) {
      const { done, value } = await readAnthropicSseChunk(reader, signal);
      completed = done;
      buffer += decoder.decode(value, { stream: !done });
      delimiter.lastIndex = scanOffset;
      for (;;) {
        const boundary = delimiter.exec(buffer);
        if (!boundary && (!completed || !buffer)) {
          break;
        }
        const frameEnd = boundary?.index ?? buffer.length;
        assertAnthropicSsePendingBufferWithinLimit(frameEnd);
        const frame = boundary ? buffer.slice(0, frameEnd) : buffer.trim();
        buffer = boundary ? buffer.slice(frameEnd + boundary[0].length) : "";
        delimiter.lastIndex = 0;
        const data = frame
          .split(/\r\n|\n|\r/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield parseAnthropicSseEventData(data);
        }
      }
      assertAnthropicSsePendingBufferWithinLimit(buffer.length);
      scanOffset = Math.max(0, buffer.length - 3);
    }
  } finally {
    if (!completed) {
      const cancellation = reader.cancel(signal?.reason).catch(() => undefined);
      if (signal?.aborted) {
        // The read continuation retains the original owner even when abort fires elsewhere.
        getAiTransportHost().observePendingProviderWork?.(cancellation);
      } else {
        await cancellation;
      }
    }
    reader.releaseLock();
  }
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

function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}) {
  const { model, context, apiKey, options } = params;
  const optionHeaders = resolveOpencodeSessionHeaders(model, options);
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsClaudeAdaptiveThinking(model);
  // Kimi's Anthropic thinking SSE is already well-formed for this parser, but
  // the OpenAI SDK compatibility sanitizer can stall before the text block.
  const fetch =
    isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true
      ? buildGuardedModelFetch(model, undefined, { sanitizeSse: false })
      : buildGuardedModelFetch(model);
  const copilot = model.provider === "github-copilot";
  const bearerAuth = copilot || usesFoundryBearerAuth(resolveModelHeaderSentinels(model));
  const isOAuthToken = !bearerAuth && isAnthropicOAuthApiKey(apiKey);
  let defaultHeaders: Record<string, string> | undefined;
  let claudeCodeVersion: string | undefined;
  let directApiKeyBetaHeader: string | undefined;
  if (bearerAuth) {
    defaultHeaders = mergeTransportHeaders(
      {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        ...(needsInterleavedBeta ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
      },
      copilot ? model.headers : omitFoundryBearerCredentialHeaders(model.headers),
      copilot ? getAiTransportHost().buildCopilotDynamicHeaders(context.messages) : undefined,
      optionHeaders,
    );
  } else {
    const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
    if (needsInterleavedBeta) {
      betaFeatures.push("interleaved-thinking-2025-05-14");
    }
    const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: isOAuthToken });
    if (isOAuthToken) {
      const identity = buildAnthropicClaudeCodeIdentity(betaHeader, model.headers, optionHeaders);
      defaultHeaders = identity.headers;
      claudeCodeVersion = identity.version;
    } else {
      defaultHeaders = mergeTransportHeaders(
        {
          accept: "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
          ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
          ...(options?.sessionId &&
          options.cacheRetention !== "none" &&
          model.compat?.sendSessionAffinityHeaders === true
            ? { "x-session-affinity": options.sessionId }
            : {}),
        },
        model.headers,
        optionHeaders,
        // Attribution policy headers override config and caller headers, as on OpenAI transports.
        getAiTransportHost().resolveProviderRequestHeaders({
          provider: model.provider,
          api: model.api,
          baseUrl: model.baseUrl,
          model,
        }),
      );
      // Binding controls are verified only on direct API-key requests, not OAuth or proxies.
      directApiKeyBetaHeader = isDirectAnthropicModel(model)
        ? (new Headers(defaultHeaders).get("anthropic-beta") ?? "")
        : undefined;
    }
  }
  const url = resolveAnthropicMessagesUrl(model.baseUrl);
  return {
    isOAuthToken,
    claudeCodeVersion,
    directApiKeyBetaHeader,
    async request(
      this: void,
      body: Record<string, unknown>,
      requestOptions?: { signal?: AbortSignal; headers?: Record<string, string> },
    ) {
      const headers = new Headers(
        mergeTransportHeaders(
          {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(bearerAuth || isOAuthToken
              ? { authorization: `Bearer ${apiKey}` }
              : { "x-api-key": apiKey }),
          },
          defaultHeaders,
        ),
      );
      for (const [name, value] of Object.entries(requestOptions?.headers ?? {})) {
        headers.set(name, value);
      }
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestOptions?.signal,
      });
      return {
        response,
        stream: response.body ? parseAnthropicSseBody(response.body, requestOptions?.signal) : [],
      };
    },
  };
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
        const { request, isOAuthToken, directApiKeyBetaHeader, claudeCodeVersion } =
          createAnthropicTransportClient({
            model,
            context: requestContext,
            apiKey,
            options: transportOptions,
          });
        const builtParams = await buildAnthropicRequest(
          model,
          requestContext,
          transportOptions,
          "transport",
          isOAuthToken,
          !isOAuthToken && supportsAnthropicServerSideFallback(model),
          claudeCodeVersion,
        );
        usedCompactionReplay = builtParams.usedCompactionReplay;
        const { params, headers } = await prepareAnthropicRequest(
          builtParams.params,
          model,
          transportOptions,
          directApiKeyBetaHeader,
        );
        const { response, stream: anthropicStream } = await request(
          { ...params, stream: true },
          { signal: transportOptions.signal, headers },
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
