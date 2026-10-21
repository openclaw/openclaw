import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  getEnvApiKey,
  resolveProviderContext,
  type Context,
  type Model,
  type ProviderCallStreamOptions,
  type ProviderContext,
  type ProviderModel,
  type SimpleStreamOptions,
  type VideoContent,
} from "openclaw/plugin-sdk/llm";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  collectProviderApiKeysForExecution,
  executeWithApiKeyRotation,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderHttpError,
  providerOperationRetryConfig,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildAssistantMessage,
  buildGoogleGenerationConfig,
  buildGoogleSimpleThinking,
  buildGuardedModelFetch,
  consumeGoogleGenerateContentStream,
  projectGoogleMessages,
  requiresGoogleToolCallId,
  convertGoogleTools,
  type GoogleStreamChunk as GoogleSseChunk,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  mergeTransportHeaders,
  notifyProviderHttpResponse,
  iterateSseFrames,
  sanitizeTransportPayloadText,
  stripSystemPromptCacheBoundary,
  transformTransportMessages,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import { parseGeminiAuth } from "./gemini-auth.js";
import { stripGoogleProviderPrefix } from "./model-id.js";
import { isGoogleNativeVideoModelId } from "./provider-models.js";
import { isOfficialGoogleAiStudioBaseUrl, normalizeGoogleApiBaseUrl } from "./provider-policy.js";
import {
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
  resolveGoogleGemini3ThinkingLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
import { isGoogleVertexCredentialsMarker } from "./vertex-adc-config.js";
import { resolveGoogleVertexAuthorizedUserHeaders } from "./vertex-adc.js";

type CanonicalGoogleTransportApi = "google-generative-ai" | "google-vertex";
type GoogleTransportApi = CanonicalGoogleTransportApi | "openclaw-google-generative-ai-transport";

type GoogleTransportModel = ProviderModel<GoogleTransportApi> & {
  headers?: Record<string, string>;
  provider: string;
};

type GoogleTransportOptions = SimpleStreamOptions &
  ProviderCallStreamOptions & {
    cachedContent?: string;
    toolChoice?:
      | "auto"
      | "none"
      | "any"
      | "required"
      | {
          type: "function";
          function: {
            name: string;
          };
        };
    thinking?: {
      enabled: boolean;
      budgetTokens?: number;
      level?: GoogleThinkingLevel;
    };
  };

type GoogleGenerateContentRequest = {
  cachedContent?: string;
  contents: Array<Record<string, unknown>>;
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  toolConfig?: Record<string, unknown>;
};

const GOOGLE_NATIVE_VIDEO_MIME: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);
const GOOGLE_VIDEO_SLOT_OMISSION = "(video omitted: native video slot unavailable)";
const GOOGLE_VIDEO_MIME_OMISSION = "(video omitted: unsupported Google video MIME type)";
const GOOGLE_REQUEST_BYTES_EXCLUSIVE = 20_000_000;
type GoogleVideoSlots = Map<Record<string, unknown>, VideoContent>;

const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS = 45_000;
const GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV = "OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS";
// Compare Google-owned publisher resources without changing outbound request paths.
const GOOGLE_VERTEX_MODEL_RESOURCE_PREFIX =
  /^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\//u;

const GOOGLE_VERTEX_DEFAULT_API_VERSION = "v1";

let toolCallCounter = 0;

function normalizeGoogleTransportRouteApi(
  api: string | undefined,
): CanonicalGoogleTransportApi | undefined {
  switch (api) {
    case "google-generative-ai":
    case "openclaw-google-generative-ai-transport":
      return "google-generative-ai";
    case "google-vertex":
      return "google-vertex";
    default:
      return undefined;
  }
}

function normalizeGoogleTransportModelRoute(model: GoogleTransportModel): GoogleTransportModel {
  const api = normalizeGoogleTransportRouteApi(model.api);
  return api && api !== model.api ? Object.assign({}, model, { api }) : model;
}

function canonicalGoogleModel(model: GoogleTransportModel): Model<GoogleTransportApi> {
  return {
    ...model,
    input: model.input.filter((type) => type !== "video"),
  } as Model<GoogleTransportApi>;
}

function supportsGoogleNativeVideo(model: GoogleTransportModel): boolean {
  return (
    model.provider === "google" &&
    normalizeGoogleTransportRouteApi(model.api) === "google-generative-ai" &&
    isOfficialGoogleAiStudioBaseUrl(model.baseUrl) &&
    isGoogleNativeVideoModelId(model.id) &&
    model.input.includes("video")
  );
}

function normalizeGoogleTransportMessageRoutes(messages: Context["messages"]): Context["messages"] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }
    const api = normalizeGoogleTransportRouteApi(msg.api);
    return api && api !== msg.api ? Object.assign({}, msg, { api }) : msg;
  });
}

function mapToolChoice(
  choice: GoogleTransportOptions["toolChoice"],
): { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] } | undefined {
  if (!choice) {
    return undefined;
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { mode: "ANY", allowedFunctionNames: [choice.function.name] };
  }
  switch (choice) {
    case "none":
      return { mode: "NONE" };
    case "any":
    case "required":
      return { mode: "ANY" };
    default:
      return { mode: "AUTO" };
  }
}

function mapStopReasonString(reason: string): "stop" | "length" | "error" {
  if (reason === "STOP") {
    return "stop";
  }
  return reason === "MAX_TOKENS" || reason === "CONTINUATION" ? "length" : "error";
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function resolveGoogleModelPath(modelId: string): string {
  if (modelId.startsWith("models/") || modelId.startsWith("tunedModels/")) {
    return modelId;
  }
  return `models/${stripGoogleProviderPrefix(modelId)}`;
}

function resolveGoogleVertexProject(options: GoogleTransportOptions | undefined): string {
  const project =
    normalizeOptionalString((options as { project?: unknown } | undefined)?.project) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveGoogleVertexLocation(options: GoogleTransportOptions | undefined): string {
  const location =
    normalizeOptionalString((options as { location?: unknown } | undefined)?.location) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function resolveGoogleVertexBaseOrigin(model: GoogleTransportModel, location: string): string {
  const configured = normalizeOptionalString(model.baseUrl);
  if (configured && !configured.includes("{location}")) {
    try {
      const url = new URL(configured);
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    } catch {
      return configured.replace(/\/+$/u, "");
    }
  }
  if (location === "global") {
    return "https://aiplatform.googleapis.com";
  }
  // Multi-region locations (eu, us) use the dedicated .rep.googleapis.com host
  // with the location embedded in the host, matching @google/genai SDK behavior.
  // A regional prefix (eu-aiplatform.googleapis.com) returns an HTML 404.
  if (location === "eu" || location === "us") {
    return `https://aiplatform.${location}.rep.googleapis.com`;
  }
  return `https://${location}-aiplatform.googleapis.com`;
}

export function buildGoogleGenerativeAiParams(
  model: GoogleTransportModel,
  context: Context | ProviderContext,
  options?: GoogleTransportOptions,
  videoSlots?: GoogleVideoSlots,
): GoogleGenerateContentRequest {
  const generationConfig: Record<string, unknown> = {
    ...buildGoogleGenerationConfig(
      model,
      options?.thinking ?? buildGoogleSimpleThinking(canonicalGoogleModel(model), options),
      options?.maxTokens,
    ),
  };
  if (typeof options?.temperature === "number") {
    generationConfig.temperature = options.temperature;
  }
  if (options?.stop !== undefined && options.stop.length > 0) {
    generationConfig.stopSequences = options.stop;
  }

  const routeModel = normalizeGoogleTransportModelRoute(model);
  const contents = projectGoogleMessages({
    model: routeModel,
    messages: transformTransportMessages(
      normalizeGoogleTransportMessageRoutes(context.messages as Context["messages"]),
      canonicalGoogleModel(routeModel),
      (id) => (requiresGoogleToolCallId(model.id) ? normalizeToolCallId(id) : id),
      { preserveCrossModelToolCallThoughtSignature: isGoogleGemini3ThinkingLevelModel(model.id) },
    ) as ProviderContext["messages"],
    replay: "managed",
    requiresToolCallSignature: isGoogleGemini3ThinkingLevelModel(model.id),
    videoPart: (video) => {
      const placeholder = { text: GOOGLE_VIDEO_SLOT_OMISSION };
      videoSlots?.set(placeholder, video);
      return placeholder;
    },
  });
  const params: GoogleGenerateContentRequest = { contents };
  const cachedContent =
    typeof options?.cachedContent === "string" ? options.cachedContent.trim() : "";
  if (cachedContent) {
    params.cachedContent = cachedContent;
  }
  if (Object.keys(generationConfig).length > 0) {
    params.generationConfig = generationConfig;
  }
  if (!cachedContent && context.systemPrompt) {
    params.systemInstruction = {
      parts: [
        {
          text: sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt)),
        },
      ],
    };
  }
  if (!cachedContent && context.tools?.length) {
    params.tools = convertGoogleTools(context.tools);
    const toolChoice = mapToolChoice(options?.toolChoice);
    if (toolChoice) {
      params.toolConfig = {
        functionCallingConfig: toolChoice,
      };
    }
  }
  return params;
}

function replaceGooglePartWithText(part: Record<string, unknown>, text: string): void {
  Object.keys(part).forEach((key) => Reflect.deleteProperty(part, key));
  part.text = text;
}

function serializeGoogleRequest(
  request: GoogleGenerateContentRequest,
  videoSlots: Record<string, unknown>[],
): string {
  let body = JSON.stringify(request);
  for (const slot of videoSlots.toReversed()) {
    if (Buffer.byteLength(body, "utf8") < GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
      break;
    }
    replaceGooglePartWithText(slot, GOOGLE_VIDEO_SLOT_OMISSION);
    body = JSON.stringify(request);
  }
  if (Buffer.byteLength(body, "utf8") >= GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
    throw new Error(
      `Google request body must be smaller than ${GOOGLE_REQUEST_BYTES_EXCLUSIVE} bytes`,
    );
  }
  return body;
}

function isGoogleOauthApiKey(apiKey: string | undefined): boolean {
  return Boolean(
    apiKey?.trimStart().startsWith("{") && parseGeminiAuth(apiKey).headers.Authorization,
  );
}

function hasGoogleAuthHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => {
    const normalized = name.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-goog-api-key";
  });
}

function resolveGoogleGemini3FirstResponseRetryMs(): number {
  const raw = process.env[GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_ENV];
  return parseStrictNonNegativeInteger(raw) ?? GOOGLE_GEMINI3_FIRST_RESPONSE_RETRY_DEFAULT_MS;
}

function buildGoogleGemini3FirstResponseRetryParams(params: {
  model: GoogleTransportModel;
  request: GoogleGenerateContentRequest;
}): GoogleGenerateContentRequest | undefined {
  const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
    modelId: params.model.id,
    thinkingLevel: "off",
  });
  if (!thinkingLevel) {
    return undefined;
  }
  const generationConfig = params.request.generationConfig;
  const thinkingConfig = {
    ...(generationConfig?.thinkingConfig as Record<string, unknown> | undefined),
  };

  // Gemini 3 defaults to dynamic high thinking when the request omits an
  // explicit level. On a zero-output stall, retry with the smallest supported
  // native level and suppress thought streaming so the recovery call prioritizes
  // producing a visible first token.
  delete thinkingConfig.thinkingBudget;
  delete thinkingConfig.includeThoughts;
  thinkingConfig.thinkingLevel = thinkingLevel;
  return {
    ...params.request,
    generationConfig: { ...generationConfig, thinkingConfig },
  };
}

function createChildSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (!signal.aborted && timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      timeout = undefined;
      controller.abort(new Error("Google Gemini first response retry deadline reached"));
    }, timeoutMs);
    timeout.unref?.();
  }
  const clearDeadline = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  return {
    signal,
    timedOut: () => timedOut,
    clearDeadline,
  };
}

type GoogleSseAttempt =
  | {
      type: "ready";
      firstChunk?: GoogleSseChunk;
      chunks: AsyncGenerator<GoogleSseChunk>;
    }
  | { type: "timeout" };

async function openGoogleSseAttempt(params: {
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
  videoSlots: Record<string, unknown>[];
  parentSignal?: AbortSignal;
  firstResponseTimeoutMs: number;
  errorPrefix: string;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
}): Promise<GoogleSseAttempt> {
  const attemptSignal =
    params.firstResponseTimeoutMs > 0
      ? createChildSignal(params.parentSignal, params.firstResponseTimeoutMs)
      : undefined;
  const signal = attemptSignal?.signal ?? params.parentSignal;
  const handleTimedOperationError = (error: unknown): GoogleSseAttempt => {
    attemptSignal?.clearDeadline();
    if (attemptSignal?.timedOut() && !params.parentSignal?.aborted) {
      return { type: "timeout" };
    }
    throw error;
  };
  let response: Response;
  try {
    response = await params.guardedFetch(params.url, {
      method: "POST",
      headers: params.headers,
      body: serializeGoogleRequest(params.request, params.videoSlots),
      signal,
    });
  } catch (error) {
    return handleTimedOperationError(error);
  }
  try {
    // Response hooks share the first-response deadline. A stalled hook must cancel
    // the unread body and enter the same Gemini fallback as a stalled fetch or body.
    await notifyProviderHttpResponse({
      options: params.options,
      response,
      model: canonicalGoogleModel(params.model),
      signal,
    });
  } catch (error) {
    return handleTimedOperationError(error);
  }
  if (!response.ok) {
    attemptSignal?.clearDeadline();
    throw await createProviderHttpError(response, params.errorPrefix);
  }
  const chunks = parseGoogleSseChunks(response, signal);
  if (!attemptSignal) {
    return { type: "ready", chunks };
  }
  const iterator = chunks[Symbol.asyncIterator]();
  let first: IteratorResult<GoogleSseChunk>;
  try {
    first = await iterator.next();
  } catch (error) {
    return handleTimedOperationError(error);
  }
  attemptSignal.clearDeadline();
  return {
    type: "ready",
    ...(!first.done ? { firstChunk: first.value } : {}),
    chunks,
  };
}

async function openGoogleSseChunks(params: {
  kind: CanonicalGoogleTransportApi;
  model: GoogleTransportModel;
  options: GoogleTransportOptions | undefined;
  guardedFetch: ReturnType<typeof buildGuardedModelFetch>;
  url: string;
  headers: Record<string, string>;
  request: GoogleGenerateContentRequest;
  videoSlots: Record<string, unknown>[];
}): Promise<Extract<GoogleSseAttempt, { type: "ready" }>> {
  const errorPrefix =
    params.kind === "google-vertex"
      ? "Google Vertex AI API error"
      : "Google Generative AI API error";
  const retryMs =
    params.kind === "google-generative-ai" &&
    isOfficialGoogleAiStudioBaseUrl(params.model.baseUrl) &&
    (isGoogleGemini3ProModel(params.model.id) || isGoogleGemini3FlashModel(params.model.id))
      ? resolveGoogleGemini3FirstResponseRetryMs()
      : 0;
  const firstAttempt = await openGoogleSseAttempt({
    ...params,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: retryMs,
    errorPrefix,
  });
  if (firstAttempt.type === "ready") {
    return firstAttempt;
  }

  // The first serialization owns video shedding. Clone only after it times out
  // so the retry inherits those exact omissions instead of restoring stale bytes.
  const retryRequest = buildGoogleGemini3FirstResponseRetryParams({
    model: params.model,
    request: params.request,
  })!;
  const retryAttempt = await openGoogleSseAttempt({
    ...params,
    request: retryRequest,
    parentSignal: params.options?.signal,
    firstResponseTimeoutMs: 0,
    errorPrefix,
  });
  if (retryAttempt.type === "timeout") {
    throw new Error("Google Gemini first response retry timed out unexpectedly");
  }
  return retryAttempt;
}

async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  let completed = false;
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    for await (const { frame, terminated } of iterateSseFrames(async () => {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      // Cancellation settles a pending read as done; never mistake that for EOF.
      signal?.throwIfAborted();
      return chunk;
    })) {
      const data = frame
        .split(/\r\n|\n|\r/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      let chunk: unknown;
      if (!terminated) {
        const trailingPayload = data || frame.trim();
        if (!trailingPayload || (!data && !trailingPayload.startsWith("{"))) {
          continue;
        }
        // Provider errors can arrive as bare JSON or data frames without their final delimiter.
        chunk = safeParseJson(trailingPayload);
        if (!isRecord(chunk) || !isRecord(chunk.error)) {
          throw new Error("Google SSE stream ended with an incomplete frame");
        }
      } else {
        if (!data || data === "[DONE]") {
          continue;
        }
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new Error("Google SSE stream returned malformed JSON");
        }
      }
      if (isRecord(chunk) && isRecord(chunk.error)) {
        const providerError = chunk.error;
        throw Object.assign(
          new Error(normalizeOptionalString(providerError.message) ?? "Google stream failed"),
          {
            code: normalizeOptionalString(providerError.status) ?? "GOOGLE_STREAM_ERROR",
            status: typeof providerError.code === "number" ? providerError.code : undefined,
            type: "google_stream_failed",
          },
        );
      }
      yield chunk as GoogleSseChunk;
    }
    completed = true;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function createGoogleTransportStreamFn(kind: CanonicalGoogleTransportApi): StreamFn {
  return (rawModel, context, rawOptions) => {
    const model = rawModel as GoogleTransportModel;
    const canonicalModel = canonicalGoogleModel(model);
    const options = rawOptions as GoogleTransportOptions | undefined;
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output = buildAssistantMessage({
        model: { api: kind, provider: model.provider, id: model.id },
        content: [],
        usage: createEmptyTransportUsage(),
        stopReason: "stop",
      });
      try {
        const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
        const guardedFetch = buildGuardedModelFetch(canonicalModel);
        const providerContext = supportsGoogleNativeVideo(model)
          ? await resolveProviderContext(context, options)
          : context;
        const videoSlots: GoogleVideoSlots = new Map();
        let params = buildGoogleGenerativeAiParams(model, providerContext, options, videoSlots);
        const nextParams = await options?.onPayload?.(params, canonicalModel);
        if (nextParams !== undefined) {
          params = nextParams as GoogleGenerateContentRequest;
        }
        const trustedVideoSlots: Record<string, unknown>[] = [];
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            value.forEach(visit);
            return;
          }
          if (!isRecord(value)) {
            return;
          }
          const video = videoSlots.get(value);
          if (video) {
            if (!GOOGLE_NATIVE_VIDEO_MIME.has(video.mimeType)) {
              replaceGooglePartWithText(value, GOOGLE_VIDEO_MIME_OMISSION);
              return;
            }
            Object.keys(value).forEach((key) => Reflect.deleteProperty(value, key));
            value.inlineData = { mimeType: video.mimeType, data: video.data };
            trustedVideoSlots.push(value);
            return;
          }
          const inlineData = isRecord(value.inlineData) ? value.inlineData : undefined;
          if (normalizeLowercaseStringOrEmpty(inlineData?.mimeType).startsWith("video/")) {
            replaceGooglePartWithText(value, GOOGLE_VIDEO_SLOT_OMISSION);
            return;
          }
          Object.values(value).forEach(visit);
        };
        visit(params);
        let requestUrl: string;
        if (kind === "google-vertex") {
          const project = encodeURIComponent(resolveGoogleVertexProject(options));
          const location = encodeURIComponent(resolveGoogleVertexLocation(options));
          // Mirror resolveGoogleModelPath: strip the google/ provider prefix so a
          // provider-qualified id does not become an invalid models/google%2F... path.
          const modelId = encodeURIComponent(stripGoogleProviderPrefix(model.id));
          const origin = resolveGoogleVertexBaseOrigin(model, decodeURIComponent(location));
          requestUrl = `${origin}/${GOOGLE_VERTEX_DEFAULT_API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent?alt=sse`;
        } else {
          const baseUrl = normalizeGoogleApiBaseUrl(model.baseUrl);
          requestUrl = `${baseUrl}/${resolveGoogleModelPath(model.id)}:streamGenerateContent?alt=sse`;
        }
        const fetchImpl = (options as { fetch?: typeof fetch } | undefined)?.fetch;
        const openSse = async (apiKeyForRequest: string | undefined) => {
          const optionHeaders = options?.headers;
          let requestHeaders: Record<string, string>;
          if (kind === "google-vertex") {
            const authHeaders = isGoogleVertexCredentialsMarker(apiKeyForRequest)
              ? await resolveGoogleVertexAuthorizedUserHeaders(fetchImpl)
              : { "x-goog-api-key": apiKeyForRequest };
            requestHeaders = mergeTransportHeaders(
              {
                "Content-Type": "application/json",
                accept: "text/event-stream",
              },
              authHeaders,
              model.headers,
              optionHeaders,
            ) ?? {
              "Content-Type": "application/json",
              accept: "text/event-stream",
            };
          } else {
            const authHeaders = apiKeyForRequest
              ? parseGeminiAuth(apiKeyForRequest).headers
              : undefined;
            requestHeaders = resolveProviderRequestHeaders({
              provider: model.provider,
              api: normalizeGoogleTransportRouteApi(model.api),
              baseUrl: model.baseUrl,
              capability: "llm",
              transport: "stream",
              defaultHeaders: mergeTransportHeaders(
                {
                  "Content-Type": "application/json",
                  accept: "text/event-stream",
                },
                authHeaders,
                model.headers,
              ),
              callerHeaders: optionHeaders,
              precedence: "caller-wins",
            }) ?? {
              "Content-Type": "application/json",
              accept: "text/event-stream",
            };
          }
          return await openGoogleSseChunks({
            kind,
            model,
            options,
            guardedFetch,
            url: requestUrl,
            headers: requestHeaders,
            request: params,
            videoSlots: trustedVideoSlots,
          });
        };
        const apiKeys =
          kind === "google-generative-ai" &&
          isOfficialGoogleAiStudioBaseUrl(model.baseUrl) &&
          !isGoogleOauthApiKey(apiKey) &&
          !hasGoogleAuthHeader(model.headers) &&
          !hasGoogleAuthHeader(options?.headers)
            ? collectProviderApiKeysForExecution({
                provider: model.provider,
                primaryApiKey: apiKey,
              })
            : [];
        const sse =
          apiKeys.length > 0
            ? await executeWithApiKeyRotation({
                provider: model.provider,
                apiKeys,
                transientRetry: providerOperationRetryConfig("read"),
                execute: openSse,
              })
            : await openSse(apiKey);
        const chunks =
          sse.firstChunk === undefined
            ? sse.chunks
            : (async function* (firstChunk: GoogleSseChunk) {
                yield firstChunk;
                yield* sse.chunks;
              })(sse.firstChunk);
        await consumeGoogleGenerateContentStream({
          chunks,
          model: canonicalModel,
          output,
          stream,
          signal: options?.signal,
          nextToolCallId: (name) => `${name || "tool"}_${Date.now()}_${++toolCallCounter}`,
          // Managed SSE has always accumulated text deltas; the SDK preserves signed Parts.
          profile: "managed",
          normalizeModelId: (id) =>
            resolveGoogleModelPath(id.replace(GOOGLE_VERTEX_MODEL_RESOURCE_PREFIX, "")),
          resolveStopReason: mapStopReasonString,
        });
      } catch (error) {
        failTransportStream({ stream, output, signal: options?.signal, error });
      }
    })();
    return eventStream;
  };
}

export function createGoogleGenerativeAiTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-generative-ai");
}

export function createGoogleVertexTransportStreamFn(): StreamFn {
  return createGoogleTransportStreamFn("google-vertex");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
