import type { Model, ModelRequestHeaders } from "openclaw/plugin-sdk/llm";
import {
  type createProviderOperationDeadline,
  resolveProviderOperationTimeoutMs,
} from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { mergeTransportHeaders } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeOllamaWireModelId } from "./model-id.js";
import { applyOllamaThinkingFloor } from "./model-reasoning.js";
import { resolveOllamaChatUrl } from "./provider-base-url.js";
import type { OllamaThinkValue } from "./stream-compat.js";
import type { OllamaChatMessage } from "./stream-messages.js";

/** A catalog-selected router destination; omitted for ordinary Ollama callers. */
export type OllamaStreamTransport = {
  requestUrl: string;
  bodyMode: "native" | "manifest";
};

export function buildOllamaRequestHeaders(
  defaultHeaders: ModelRequestHeaders | undefined,
  requestHeaders: ModelRequestHeaders | undefined,
  routedAuthorization: { Authorization: string } | undefined,
): Record<string, string> {
  return (
    omitNullRequestHeaders(
      mergeTransportHeaders(
        { "Content-Type": "application/json" },
        defaultHeaders,
        requestHeaders,
        routedAuthorization,
      ),
    ) ?? {}
  );
}

export function resolveOllamaTransportUrl(
  baseUrl: string,
  transport?: OllamaStreamTransport,
): string {
  if (transport === undefined) {
    return resolveOllamaChatUrl(baseUrl);
  }
  const invalid = () => new Error("Invalid catalog-selected Ollama transport");
  if (
    (transport.bodyMode !== "native" && transport.bodyMode !== "manifest") ||
    Object.keys(transport).some((key) => key !== "requestUrl" && key !== "bodyMode")
  ) {
    throw invalid();
  }
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(transport.requestUrl);
  } catch {
    throw invalid();
  }
  const basePath = base.pathname.replace(/\/$/u, "");
  const manifestPrefix = `${basePath}/v1/proxy/ollama/`;
  const validPath =
    transport.bodyMode === "native"
      ? basePath.endsWith("/v1/native/ollama") && target.pathname === `${basePath}/api/chat`
      : target.pathname.startsWith(manifestPrefix) &&
        /^[a-z0-9][a-z0-9_-]*$/u.test(target.pathname.slice(manifestPrefix.length));
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.origin !== base.origin ||
    target.href !== transport.requestUrl ||
    !validPath
  ) {
    throw invalid();
  }
  return target.href;
}

export function resolveOllamaRequestTimeoutMs(
  model: object,
  options: { requestTimeoutMs?: unknown; timeoutMs?: unknown } | undefined,
): number | undefined {
  const raw =
    options?.requestTimeoutMs ??
    options?.timeoutMs ??
    // SAFETY: This optional field stays unknown until the finite positive number check below.
    (model as { requestTimeoutMs?: unknown }).requestTimeoutMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

export function resolveOllamaRemainingTimeout(
  model: object,
  options: { requestTimeoutMs?: unknown; timeoutMs?: unknown } | undefined,
  deadline: ReturnType<typeof createProviderOperationDeadline> | undefined,
  suppliedTimeout: number | undefined,
): number | undefined {
  return deadline && suppliedTimeout !== undefined
    ? resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: suppliedTimeout })
    : resolveOllamaRequestTimeoutMs(model, options);
}

export function serializeOllamaBody(
  payload: unknown,
  model: Pick<Model, "id" | "thinkingLevelMap">,
  selectedWireModel: string,
  bodyMode: OllamaStreamTransport["bodyMode"] | undefined,
): string | undefined {
  // Applied after payload hooks, so a `false` from any writer gets the model's floor.
  const finalizedBody = applyOllamaThinkingFloor(payload, model);
  if (
    bodyMode &&
    (!isRecord(finalizedBody) ||
      finalizedBody.model !== selectedWireModel ||
      finalizedBody.stream !== true)
  ) {
    throw new Error("Catalog-selected Ollama model and streaming mode must remain unchanged");
  }
  return JSON.stringify(bodyMode === "manifest" ? { body: finalizedBody } : finalizedBody);
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  think?: OllamaThinkValue;
  format?: "json" | Record<string, unknown>;
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function buildOllamaChatRequest(params: {
  modelId: string;
  providerId?: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  requestParams?: Record<string, unknown>;
  stream?: boolean;
}): OllamaChatRequest {
  return {
    model: normalizeOllamaWireModelId(params.modelId, params.providerId),
    messages: params.messages,
    stream: params.stream ?? true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.options ? { options: params.options } : {}),
    ...params.requestParams,
  };
}
