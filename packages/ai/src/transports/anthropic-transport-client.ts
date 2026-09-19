/**
 * Anthropic Messages transport client: base-URL resolution, the SSE-backed
 * HTTP client, and the auth routing that decides which credential and which
 * identity headers one request carries — subscription OAuth with the Claude
 * Code identity, Copilot and Foundry bearer, gateway and plain API key. The
 * stream module owns the payload and the response; this module owns the client
 * it sends them through.
 */
import type { Context, Model, SimpleStreamOptions } from "@openclaw/llm-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost } from "../host.js";
import type { AnthropicOptions } from "../provider-options.js";
import {
  isAnthropicOAuthApiKey,
  omitFoundryBearerCredentialHeaders,
  usesFoundryBearerAuth,
} from "../providers/anthropic-auth-headers.js";
import {
  type AnthropicClaudeCodeIdentity,
  resolveAnthropicClaudeCodeIdentity,
  resolveClaudeOpus5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  usesClaudeFable5MessagesContract,
} from "../providers/anthropic-model-contract.js";
import { ANTHROPIC_SERVER_SIDE_FALLBACK_BETA } from "../providers/anthropic-server-fallback.js";
import { isDirectAnthropicModel } from "./anthropic-payload-policy.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";
import { mergeTransportHeaders } from "./transport-stream-shared.js";
import {
  createAbortError as createNamedAbortError,
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  resolveModelHeaderSentinels,
} from "./transport-utils.js";

export type AnthropicTransportModel = Model<"anthropic-messages"> & {
  headers?: Record<string, string>;
  provider: string;
};

export type AnthropicTransportOptions = AnthropicOptions &
  Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "stop"> & {
    authProfileId?: string;
  };
type AnthropicMessagesClient = {
  messages: {
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<{
      response: Response;
      stream: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;
    }>;
  };
};

/**
 * Server-side refusal fallback is a first-party Claude API beta: proxies and
 * Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
 * identity) requests are excluded until the beta is verified there.
 */
export function useAnthropicServerSideFallback(model: AnthropicTransportModel): boolean {
  return (
    (usesClaudeFable5MessagesContract(model) ||
      resolveClaudeOpus5ModelIdentity(model) !== undefined) &&
    isDirectAnthropicModel(model)
  );
}

/**
 * Whether the request will present the Claude Code identity, decided from the
 * credential alone so the identity can be settled before any other work. It
 * mirrors the route chain in {@link createAnthropicTransportClient}: the
 * Copilot and Foundry routes are taken before the OAuth branch even when the
 * key looks like a subscription token, and they carry no identity.
 */
function usesAnthropicClaudeCodeIdentity(model: AnthropicTransportModel, apiKey: string): boolean {
  if (
    model.provider === "github-copilot" ||
    usesFoundryBearerAuth(resolveModelHeaderSentinels(model))
  ) {
    return false;
  }
  return isAnthropicOAuthApiKey(apiKey);
}

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

export function withEffectiveAnthropicBaseUrl(
  model: AnthropicTransportModel,
): AnthropicTransportModel {
  const baseUrl = resolveAnthropicBaseUrl(model.baseUrl);
  return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

// Mirror the fetch sanitizer cap here because compatible routes such as Kimi
// bypass that layer; without a parser-local guard, partial frames grow forever.
const ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS = 16 * 1024 * 1024;

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

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function parseAnthropicSseEventData(data: string): Record<string, unknown> {
  try {
    // A non-object frame reaches the stream reducer, which reads known keys only.
    // SAFETY: an Anthropic SSE data frame is a JSON object.
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
  try {
    while (true) {
      const { done, value } = await readAnthropicSseChunk(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        assertAnthropicSsePendingBufferWithinLimit(frameEnd);
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield parseAnthropicSseEventData(data);
        }
        frameEnd = buffer.indexOf("\n\n");
      }
      assertAnthropicSsePendingBufferWithinLimit(buffer.length);
    }
    const tailBuffer = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n");
    assertAnthropicSsePendingBufferWithinLimit(tailBuffer.length);
    const tail = tailBuffer.trim();
    if (tail) {
      const data = tail
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") {
        yield parseAnthropicSseEventData(data);
      }
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

function createAnthropicMessagesClient(params: {
  apiKey?: string | null;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch: typeof fetch;
}): AnthropicMessagesClient {
  const url = resolveAnthropicMessagesUrl(params.baseURL);
  return {
    messages: {
      async stream(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal; headers?: Record<string, string> },
      ) {
        const headers = new Headers(
          mergeTransportHeaders(
            {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              ...(params.apiKey ? { "x-api-key": params.apiKey } : {}),
              ...(params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}),
            },
            params.defaultHeaders,
          ),
        );
        for (const [name, value] of Object.entries(options?.headers ?? {})) {
          headers.set(name, value);
        }
        const response = await params.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        return {
          response,
          stream: response.body ? parseAnthropicSseBody(response.body, options?.signal) : [],
        };
      },
    },
  };
}

export async function createAnthropicTransportClient(params: {
  model: AnthropicTransportModel;
  context: Context;
  apiKey: string;
  options: AnthropicTransportOptions | undefined;
}): Promise<{
  client: AnthropicMessagesClient;
  isOAuthToken: boolean;
  directApiKeyBetaHeader?: string;
  /** Set on the OAuth route only; the billing block must come from this snapshot. */
  claudeCodeIdentity?: AnthropicClaudeCodeIdentity;
}> {
  const { model, context, apiKey, options } = params;
  // Settle the identity before any other request work. The gate is bounded
  // from the probe's start, and the host work below can be slow on a cold
  // process — building the guarded fetch loads plugin metadata — so anything
  // done first spends that budget and leaves the request on the pinned
  // fallback. Routes that never present the identity skip the gate entirely.
  const claudeCodeIdentity = usesAnthropicClaudeCodeIdentity(model, apiKey)
    ? await resolveAnthropicClaudeCodeIdentity()
    : undefined;
  const optionHeaders = resolveOpencodeSessionHeaders(model, options);
  const needsInterleavedBeta =
    (options?.interleavedThinking ?? true) && !supportsClaudeAdaptiveThinking(model);
  // Kimi's Anthropic thinking SSE is already well-formed for this parser, but
  // the OpenAI SDK compatibility sanitizer can stall before the text block.
  const fetch =
    isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true
      ? buildGuardedModelFetch(model, undefined, { sanitizeSse: false })
      : buildGuardedModelFetch(model);
  if (model.provider === "github-copilot") {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          model.headers,
          getAiTransportHost().buildCopilotDynamicHeaders(context.messages),
          optionHeaders,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  if (usesFoundryBearerAuth(resolveModelHeaderSentinels(model))) {
    const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
          },
          omitFoundryBearerCredentialHeaders(model.headers),
          optionHeaders,
        ),
        fetch,
      }),
      isOAuthToken: false,
    };
  }
  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
  if (needsInterleavedBeta) {
    betaFeatures.push("interleaved-thinking-2025-05-14");
  }
  // Defined exactly on this route (see usesAnthropicClaudeCodeIdentity), whose
  // user-agent and billing block must come from that one snapshot.
  if (claudeCodeIdentity) {
    const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
    return {
      client: createAnthropicMessagesClient({
        apiKey: null,
        authToken: apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: mergeTransportHeaders(
          {
            accept: "application/json",
            "anthropic-dangerous-direct-browser-access": "true",
            ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
            "user-agent": claudeCodeIdentity.userAgent,
            "x-app": "cli",
          },
          model.headers,
          optionHeaders,
        ),
        fetch,
      }),
      isOAuthToken: true,
      claudeCodeIdentity,
    };
  }
  if (useAnthropicServerSideFallback(model)) {
    betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
  const defaultHeaders = mergeTransportHeaders(
    {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
    },
    model.headers,
    optionHeaders,
  );
  return {
    client: createAnthropicMessagesClient({
      apiKey,
      baseURL: model.baseUrl,
      defaultHeaders,
      fetch,
    }),
    isOAuthToken: false,
    // Binding controls are verified only on direct API-key requests, not OAuth or proxies.
    directApiKeyBetaHeader: isDirectAnthropicModel(model)
      ? (new Headers(defaultHeaders).get("anthropic-beta") ?? "")
      : undefined,
  };
}
