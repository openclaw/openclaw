import { AnthropicVertex as AnthropicVertexSdk } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth, type GoogleAuthOptions } from "google-auth-library";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  stream as streamDefault,
  type Model,
  type ProviderStreamOptions,
} from "openclaw/plugin-sdk/llm";
import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  requiresClaudeMandatoryAdaptiveThinking,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAnthropicThinkingOptions,
  clampMaxTokensToModel,
  copyProviderAcceptanceObserver,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { resolveAnthropicVertexClientRegion } from "./region-endpoint.js";
import { resolveAnthropicVertexAdcCredentials, resolveAnthropicVertexProjectId } from "./region.js";

const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Proxy settings are process-stable. Reuse one dispatcher so auth requests do
// not leak sockets while avoiding gaxios's broken node-fetch dynamic import.
let googleAuthDispatcher: EnvHttpProxyAgent | undefined;

const googleAuthFetch: typeof globalThis.fetch = (input, init) => {
  googleAuthDispatcher ??= new EnvHttpProxyAgent();
  const fetchInit = { ...init } as Parameters<typeof undiciFetch>[1] & { agent?: unknown };
  delete fetchInit.agent;
  fetchInit.dispatcher = googleAuthDispatcher;
  return undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    fetchInit,
  ) as unknown as ReturnType<typeof globalThis.fetch>;
};

type AnthropicVertexTransportOptions = ProviderStreamOptions &
  Parameters<typeof applyAnthropicThinkingOptions>[1] & { client?: unknown };

type AnthropicVertexClientOptions = {
  baseURL?: string;
  googleAuth: GoogleAuth;
  projectId?: string;
  region: string;
};

/** Injectable dependencies for Anthropic Vertex stream tests. */
export type AnthropicVertexStreamDeps = {
  AnthropicVertex: new (options: AnthropicVertexClientOptions) => unknown;
  GoogleAuth: new (options?: GoogleAuthOptions) => GoogleAuth;
  streamAnthropic: typeof streamDefault;
};

const defaultAnthropicVertexStreamDeps: AnthropicVertexStreamDeps = {
  AnthropicVertex: AnthropicVertexSdk,
  GoogleAuth,
  streamAnthropic: streamDefault,
};

/**
 * Create a StreamFn that routes through OpenClaw's generic model stream with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by the shared model runtime - we only supply the GCP-authenticated
 * client and provider transport options.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
  deps: AnthropicVertexStreamDeps = defaultAnthropicVertexStreamDeps,
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  // GoogleAuth carries clientOptions into file-backed ADC clients. Keep the
  // proxy-aware transport provider-local; a window shim changes detection globally.
  const adcConfig = resolveAnthropicVertexAdcCredentials(env);
  const googleAuth = new deps.GoogleAuth({
    scopes: [GOOGLE_CLOUD_PLATFORM_SCOPE],
    ...(adcConfig ? { credentials: adcConfig } : {}),
    clientOptions: {
      transporterOptions: { fetchImplementation: googleAuthFetch },
    },
  });
  const client = new deps.AnthropicVertex({
    googleAuth,
    region,
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    // Simple completions use a synthetic registry API to select this plugin.
    // The shared Anthropic transport must receive its canonical API or it recurses.
    const transportModel = (
      model.api === "anthropic-messages" ? model : { ...model, api: "anthropic-messages" as const }
    ) as Model<"anthropic-messages">;
    // Sonnet 5 and Opus 5 default thinking on when the caller omits reasoning.
    const adaptiveDefaultClaude5 =
      resolveClaudeSonnet5ModelIdentity(transportModel) !== undefined ||
      resolveClaudeOpus5ModelIdentity(transportModel) !== undefined;
    // Vertex does not inherit the direct API's optional defaults for other models.
    const reasoning =
      options?.reasoning ??
      (adaptiveDefaultClaude5
        ? "high"
        : requiresClaudeMandatoryAdaptiveThinking(transportModel)
          ? undefined
          : "off");
    const opts: AnthropicVertexTransportOptions = copyProviderAcceptanceObserver(options, {
      client,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      maxTokens: Math.floor(
        clampMaxTokensToModel(transportModel, options?.maxTokens ?? transportModel.maxTokens),
      ),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      // The shared anthropic-messages transport already splits the system prompt
      // cache boundary and budgets all cache_control markers; re-applying the
      // payload policy here marked the uncached suffix and breached the 4-marker cap.
      onPayload: options?.onPayload,
      onResponse: options?.onResponse,
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    });

    applyAnthropicThinkingOptions(
      transportModel,
      opts,
      { reasoning, thinkingBudgets: options?.thinkingBudgets },
      "provider",
    );
    return deps.streamAnthropic(transportModel, context, opts);
  };
}

function resolveAnthropicVertexSdkBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const url = URL.parse(trimmed);
  if (!url) {
    return trimmed;
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (!normalizedPath.endsWith("/v1")) {
    url.pathname = `${normalizedPath}/v1`;
    return url.toString().replace(/\/$/, "");
  }
  return trimmed;
}

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
  deps?: AnthropicVertexStreamDeps,
): StreamFn {
  return createAnthropicVertexStreamFn(
    resolveAnthropicVertexProjectId(env),
    resolveAnthropicVertexClientRegion({
      baseUrl: model.baseUrl,
      env,
    }),
    resolveAnthropicVertexSdkBaseUrl(model.baseUrl),
    deps,
    env,
  );
}
