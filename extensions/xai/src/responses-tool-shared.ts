import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildResponsesSearchRequest,
  postTrustedWebToolsJson,
  type ResponsesSearchResponse,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString as trimString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveXaiCatalogEntry } from "../model-definitions.js";
import { isXaiGrokReleaseAtLeast } from "../model-id.js";
import { applyXaiRuntimeModelCompat } from "../runtime-model-compat.js";

const XAI_RESPONSES_BASE_URL = "https://api.x.ai/v1";
export const XAI_RESPONSES_ENDPOINT = `${XAI_RESPONSES_BASE_URL}/responses`;

export function resolveXaiResponsesEndpoint(baseUrl?: unknown): string {
  return `${(trimString(baseUrl) ?? XAI_RESPONSES_BASE_URL).replace(/\/+$/, "")}/responses`;
}

export function resolveXaiToolDefaultReasoningEffort(
  model: string,
  preferred: "none" | "low",
): "none" | "low" | undefined {
  // Per-model tool defaults must survive changes to the setup default.
  return model === "grok-4.3" || isXaiGrokReleaseAtLeast(model, [4, 6]) ? preferred : undefined;
}

function buildXaiResponsesToolBody(params: {
  model: string;
  inputText: string;
  tools: Array<Record<string, unknown>>;
  maxTurns?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}): Record<string, unknown> {
  const requested = params.reasoningEffort;
  let reasoningEffort: string | undefined = requested;
  const model = requested ? resolveXaiCatalogEntry(params.model) : undefined;
  if (requested && model) {
    const levels = applyXaiRuntimeModelCompat(model).thinkingLevelMap;
    const level = requested === "none" ? "off" : requested;
    // Direct tools must obey the same supported efforts as agent requests.
    reasoningEffort = levels[level] ?? (level === "off" ? levels.minimal : undefined) ?? undefined;
  }
  return buildResponsesSearchRequest({ ...params, reasoningEffort });
}

export async function requestXaiResponsesTool<T>(
  params: Parameters<typeof buildXaiResponsesToolBody>[0] & {
    apiKey: string;
    endpoint: string;
    timeoutSeconds: number;
    errorLabel: string;
    signal?: AbortSignal;
  },
  parseResponse: (data: ResponsesSearchResponse) => T,
): Promise<T> {
  return await postTrustedWebToolsJson(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      ...(params.signal ? { signal: params.signal } : {}),
      body: buildXaiResponsesToolBody(params),
      errorLabel: "xAI",
    },
    async (response) =>
      parseResponse(await readProviderJsonObjectResponse(response, params.errorLabel)),
  );
}
