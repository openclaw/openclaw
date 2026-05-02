import { BaseAnthropic } from "@anthropic-ai/sdk/client";
import * as AnthropicResources from "@anthropic-ai/sdk/resources/index";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  streamAnthropic as streamAnthropicDefault,
  type AnthropicOptions,
  type Model,
} from "@mariozechner/pi-ai";
import { GoogleAuth, type AuthClient } from "google-auth-library";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { resolveAnthropicVertexClientRegion, resolveAnthropicVertexProjectId } from "./region.js";

type AnthropicVertexEffort = NonNullable<AnthropicOptions["effort"]>;
type AnthropicVertexAdaptiveEffort = AnthropicVertexEffort | "xhigh";
type AnthropicVertexClientOptions = ConstructorParameters<typeof BaseAnthropic>[0] & {
  accessToken?: string | null;
  authClient?: AuthClient | null;
  googleAuth?: GoogleAuth | null;
  projectId?: string | null;
  region?: string | null;
};
type HeaderValue = string | null | undefined;
type HeaderValueInput = HeaderValue | readonly HeaderValue[];
type AnthropicHeaderContainer = {
  readonly values: Headers;
  readonly nulls: Set<string>;
  readonly [key: symbol]: true | Headers | Set<string>;
};

const ANTHROPIC_VERTEX_VERSION = "vertex-2023-10-16";
const MODEL_ENDPOINTS = new Set(["/v1/messages", "/v1/messages?beta=true"]);
const ANTHROPIC_HEADER_CONTAINER_BRAND = Symbol.for("brand.privateNullableHeaders");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAnthropicHeaderContainer(value: unknown): value is AnthropicHeaderContainer {
  return (
    isRecord(value) &&
    (value as { [key: symbol]: unknown })[ANTHROPIC_HEADER_CONTAINER_BRAND] === true &&
    (value as { values?: unknown }).values instanceof Headers &&
    (value as { nulls?: unknown }).nulls instanceof Set
  );
}

function* iterateHeaders(
  headers: unknown,
): IterableIterator<readonly [name: string, value: string | null]> {
  if (!headers) {
    return;
  }
  if (isAnthropicHeaderContainer(headers)) {
    yield* headers.values.entries();
    for (const name of headers.nulls) {
      yield [name, null];
    }
    return;
  }

  let shouldClear = false;
  let entries: Iterable<readonly [string, HeaderValueInput]>;
  if (headers instanceof Headers) {
    entries = headers.entries();
  } else if (Array.isArray(headers)) {
    entries = headers as readonly (readonly [string, HeaderValueInput])[];
  } else if (isRecord(headers)) {
    shouldClear = true;
    entries = Object.entries(headers) as readonly (readonly [string, HeaderValueInput])[];
  } else {
    return;
  }

  for (const [name, rawValue] of entries) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    let didClear = false;
    for (const value of values) {
      if (value === undefined) {
        continue;
      }
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value === null ? null : String(value)];
    }
  }
}

function mergeHeaders(first: unknown, second: unknown): AnthropicHeaderContainer {
  const values = new Headers();
  const nulls = new Set<string>();

  for (const headers of [first, second]) {
    const seenHeaders = new Set<string>();
    for (const [name, value] of iterateHeaders(headers)) {
      const lowerName = name.toLowerCase();
      if (!seenHeaders.has(lowerName)) {
        values.delete(name);
        seenHeaders.add(lowerName);
      }
      if (value === null) {
        values.delete(name);
        nulls.add(lowerName);
      } else {
        values.append(name, value);
        nulls.delete(lowerName);
      }
    }
  }

  return {
    [ANTHROPIC_HEADER_CONTAINER_BRAND]: true,
    values,
    nulls,
  };
}

function getHeaderValue(headers: unknown, name: string): unknown {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (isAnthropicHeaderContainer(headers)) {
    return headers.values.get(name);
  }
  if (isRecord(headers)) {
    return headers[name];
  }
  return undefined;
}

class AnthropicVertexClient extends BaseAnthropic {
  accessToken: string | null;
  beta: AnthropicResources.Beta;
  messages: AnthropicResources.Messages;
  projectId: string | null;
  region: string;

  private auth?: GoogleAuth;
  private authClientPromise: Promise<AuthClient>;

  constructor({
    baseURL = process.env.ANTHROPIC_VERTEX_BASE_URL,
    region = process.env.CLOUD_ML_REGION ?? null,
    projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID ?? null,
    ...opts
  }: AnthropicVertexClientOptions = {}) {
    if (!region) {
      throw new Error(
        "No region was given. The client should be instantiated with the `region` option or the `CLOUD_ML_REGION` environment variable should be set.",
      );
    }

    super({
      baseURL: baseURL ?? resolveDefaultAnthropicVertexBaseUrl(region),
      ...opts,
    });

    this.messages = makeMessagesResource(this);
    this.beta = makeBetaResource(this);
    this.region = region;
    this.projectId = projectId;
    this.accessToken = opts.accessToken ?? null;

    if (opts.authClient && opts.googleAuth) {
      throw new Error(
        "You cannot provide both `authClient` and `googleAuth`. Please provide only one of them.",
      );
    }
    if (opts.authClient) {
      this.authClientPromise = Promise.resolve(opts.authClient);
    } else {
      this.auth =
        opts.googleAuth ??
        new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
      this.authClientPromise = this.auth.getClient();
    }
  }

  validateHeaders(): void {
    // Vertex auth is resolved asynchronously in prepareOptions.
  }

  async prepareOptions(options: Parameters<BaseAnthropic["prepareOptions"]>[0]): Promise<void> {
    const authClient = await this.authClientPromise;
    const authHeaders = await authClient.getRequestHeaders();
    const projectId = authClient.projectId ?? getHeaderValue(authHeaders, "x-goog-user-project");

    if (!this.projectId && typeof projectId === "string" && projectId.length > 0) {
      this.projectId = projectId;
    }
    options.headers = mergeHeaders(authHeaders, options.headers) as typeof options.headers;
  }

  async buildRequest(
    options: Parameters<BaseAnthropic["buildRequest"]>[0],
  ): ReturnType<BaseAnthropic["buildRequest"]> {
    if (isRecord(options.body)) {
      options.body = { ...options.body };
    }
    if (isRecord(options.body) && !options.body.anthropic_version) {
      options.body.anthropic_version = ANTHROPIC_VERTEX_VERSION;
    }

    if (MODEL_ENDPOINTS.has(options.path) && options.method === "post") {
      if (!this.projectId) {
        throw new Error(
          "No projectId was given and it could not be resolved from credentials. The client should be instantiated with the `projectId` option or the `ANTHROPIC_VERTEX_PROJECT_ID` environment variable should be set.",
        );
      }
      if (!isRecord(options.body)) {
        throw new Error("Expected request body to be an object for post /v1/messages");
      }

      const model = options.body.model;
      if (typeof model !== "string" || model.length === 0) {
        throw new Error("Expected request body model to be a string for post /v1/messages");
      }
      options.body.model = undefined;
      const specifier = options.body.stream ? "streamRawPredict" : "rawPredict";
      options.path = `/projects/${this.projectId}/locations/${this.region}/publishers/anthropic/models/${model}:${specifier}`;
    }

    if (
      options.path === "/v1/messages/count_tokens" ||
      (options.path === "/v1/messages/count_tokens?beta=true" && options.method === "post")
    ) {
      if (!this.projectId) {
        throw new Error(
          "No projectId was given and it could not be resolved from credentials. The client should be instantiated with the `projectId` option or the `ANTHROPIC_VERTEX_PROJECT_ID` environment variable should be set.",
        );
      }
      options.path = `/projects/${this.projectId}/locations/${this.region}/publishers/anthropic/models/count-tokens:rawPredict`;
    }

    return super.buildRequest(options);
  }
}

function resolveDefaultAnthropicVertexBaseUrl(region: string): string {
  switch (region) {
    case "global":
      return "https://aiplatform.googleapis.com/v1";
    case "us":
      return "https://aiplatform.us.rep.googleapis.com/v1";
    case "eu":
      return "https://aiplatform.eu.rep.googleapis.com/v1";
    default:
      return `https://${region}-aiplatform.googleapis.com/v1`;
  }
}

function makeMessagesResource(client: BaseAnthropic): AnthropicResources.Messages {
  const resource = new AnthropicResources.Messages(client);
  delete (resource as { batches?: unknown }).batches;
  return resource;
}

function makeBetaResource(client: BaseAnthropic): AnthropicResources.Beta {
  const resource = new AnthropicResources.Beta(client);
  delete (resource.messages as { batches?: unknown }).batches;
  return resource;
}

export type AnthropicVertexStreamDeps = {
  AnthropicVertex: new (options: AnthropicVertexClientOptions) => unknown;
  streamAnthropic: typeof streamAnthropicDefault;
};

const defaultAnthropicVertexStreamDeps: AnthropicVertexStreamDeps = {
  AnthropicVertex: AnthropicVertexClient as AnthropicVertexStreamDeps["AnthropicVertex"],
  streamAnthropic: streamAnthropicDefault,
};

export const __testing = {
  AnthropicVertexClient,
};

function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}

function isClaudeOpus46Model(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapAnthropicAdaptiveEffort(
  reasoning: string,
  modelId: string,
): AnthropicVertexAdaptiveEffort {
  const effortMap: Record<string, AnthropicVertexAdaptiveEffort> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: isClaudeOpus47Model(modelId) ? "xhigh" : isClaudeOpus46Model(modelId) ? "max" : "high",
  };
  return effortMap[reasoning] ?? "high";
}

function resolveAnthropicVertexMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const modelMax =
    typeof params.modelMaxTokens === "number" &&
    Number.isFinite(params.modelMaxTokens) &&
    params.modelMaxTokens > 0
      ? Math.floor(params.modelMaxTokens)
      : undefined;
  const requested =
    typeof params.requestedMaxTokens === "number" &&
    Number.isFinite(params.requestedMaxTokens) &&
    params.requestedMaxTokens > 0
      ? Math.floor(params.requestedMaxTokens)
      : undefined;

  if (modelMax !== undefined && requested !== undefined) {
    return Math.min(requested, modelMax);
  }
  return requested ?? modelMax;
}

function createAnthropicVertexOnPayload(params: {
  model: { api: string; baseUrl?: string; provider: string };
  cacheRetention: AnthropicOptions["cacheRetention"] | undefined;
  onPayload: AnthropicOptions["onPayload"] | undefined;
}): NonNullable<AnthropicOptions["onPayload"]> {
  const policy = resolveAnthropicPayloadPolicy({
    provider: params.model.provider,
    api: params.model.api,
    baseUrl: params.model.baseUrl,
    cacheRetention: params.cacheRetention,
    enableCacheControl: true,
  });

  function applyPolicy(payload: unknown): unknown {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      applyAnthropicPayloadPolicyToParams(payload as Record<string, unknown>, policy);
    }
    return payload;
  }

  return async (payload, model) => {
    const shapedPayload = applyPolicy(payload);
    const nextPayload = await params.onPayload?.(shapedPayload, model);
    if (nextPayload === undefined || nextPayload === shapedPayload) {
      return shapedPayload;
    }
    return applyPolicy(nextPayload);
  };
}

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
  deps: AnthropicVertexStreamDeps = defaultAnthropicVertexStreamDeps,
): StreamFn {
  const client = new deps.AnthropicVertex({
    region,
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    const transportModel = model as Model<"anthropic-messages"> & {
      api: string;
      baseUrl?: string;
      provider: string;
    };
    const maxTokens = resolveAnthropicVertexMaxTokens({
      modelMaxTokens: transportModel.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });
    const opts: AnthropicOptions = {
      client: client as AnthropicOptions["client"],
      temperature: options?.temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: createAnthropicVertexOnPayload({
        model: transportModel,
        cacheRetention: options?.cacheRetention,
        onPayload: options?.onPayload,
      }),
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (options?.reasoning) {
      if (supportsAdaptiveThinking(model.id)) {
        opts.thinkingEnabled = true;
        opts.effort = mapAnthropicAdaptiveEffort(
          options.reasoning,
          model.id,
        ) as AnthropicVertexEffort;
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return deps.streamAnthropic(transportModel, context, opts);
  };
}

function resolveAnthropicVertexSdkBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
    if (!normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/v1`;
      return url.toString().replace(/\/$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
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
  );
}
