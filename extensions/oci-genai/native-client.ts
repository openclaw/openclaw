/**
 * OCI Generative AI **native** chat client.
 *
 * Mirrors Locus's `OCIModel` (the SDK-transport sibling of `OCIOpenAIModel`)
 * for models that don't speak the `/openai/v1` shape — most importantly
 * Cohere R-series, which OCI exposes only through the native protocol.
 *
 * Endpoint:
 *   POST https://inference.generativeai.<region>.oci.oraclecloud.com
 *        /20231130/actions/chat
 *
 * Body (Cohere example):
 *   {
 *     "compartmentId": "<ocid>",
 *     "servingMode":   { "modelId": "cohere.command-r-plus-08-2024",
 *                        "servingType": "ON_DEMAND" },
 *     "chatRequest":   { "apiFormat": "COHERE",
 *                        "message": "Hello",
 *                        "chatHistory": [...],
 *                        "maxTokens": 1024,
 *                        ... family-specific fields ... }
 *   }
 *
 * Each model family (Cohere, Generic / Meta-Llama, etc.) has its own
 * `apiFormat` value and its own subset of `chatRequest` fields.  This
 * file currently implements **Cohere** as the canonical "non-OpenAI"
 * case; Generic-format models (Meta-Llama on the native endpoint) work
 * but are normally reached through the OpenAI-compat path so are not
 * a priority here.
 *
 * Reference:
 *   https://docs.oracle.com/en-us/iaas/api/#/en/generative-ai-inference/20231130/Chat/Chat
 */

import type { OciRequestSigner } from "./oci-signer.js";
import { buildOciGenAINativeBaseUrl, type OciRegion } from "./regions.js";

export type OciNativeApiFormat = "COHERE" | "GENERIC";

export type OciNativeChatRequest = {
  /** OCID of the compartment the GenAI request is billed against. */
  readonly compartmentId: string;
  /** Region routes the request to the correct inference cluster. */
  readonly region: OciRegion;
  /** Fully-qualified model id, e.g. "cohere.command-r-plus-08-2024". */
  readonly modelId: string;
  readonly servingType?: "ON_DEMAND" | "DEDICATED";
  readonly apiFormat: OciNativeApiFormat;
  /** Latest user turn for COHERE; for GENERIC use messages[]. */
  readonly message?: string;
  /** Prior turns, each {role, message} for COHERE. */
  readonly chatHistory?: ReadonlyArray<{
    readonly role: "USER" | "CHATBOT" | "SYSTEM";
    readonly message: string;
  }>;
  /** Generic-format messages list (for Meta-Llama on native endpoint). */
  readonly messages?: ReadonlyArray<{
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }>;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly seed?: number;
  /** Extra fields passed through to OCI without validation. */
  readonly extras?: Readonly<Record<string, unknown>>;
};

export type OciNativeChatResponse = {
  readonly text: string;
  readonly finishReason: string | undefined;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly raw: unknown;
};

export type OciNativeClientOptions = {
  readonly signer: OciRequestSigner;
  /**
   * Override fetch (for tests / proxy injection).  Production callers
   * leave this unset and the global `fetch` is used.
   */
  readonly fetchImpl?: typeof fetch;
};

export class OciNativeClient {
  readonly #signer: OciRequestSigner;
  readonly #fetch: typeof fetch;

  constructor(options: OciNativeClientOptions) {
    this.#signer = options.signer;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async chat(request: OciNativeChatRequest): Promise<OciNativeChatResponse> {
    const url = `${buildOciGenAINativeBaseUrl(request.region)}/actions/chat`;
    const body = JSON.stringify(buildNativeChatPayload(request));
    const headers = await this.#signer.sign({
      method: "POST",
      url,
      body,
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    const response = await this.#fetch(url, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OciNativeError(
        `OCI native chat failed: ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
        { status: response.status },
      );
    }
    const json = (await response.json()) as Record<string, unknown>;
    return parseNativeChatResponse(json);
  }
}

export class OciNativeError extends Error {
  readonly code = "OCI_NATIVE";
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: Error }) {
    super(message, options);
    this.name = "OciNativeError";
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildNativeChatPayload(request: OciNativeChatRequest): Record<string, unknown> {
  const chatRequest: Record<string, unknown> = {
    apiFormat: request.apiFormat,
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { topP: request.topP } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };
  if (request.apiFormat === "COHERE") {
    if (!request.message) {
      throw new OciNativeError("Cohere format requires `message`");
    }
    chatRequest.message = request.message;
    if (request.chatHistory && request.chatHistory.length > 0) {
      chatRequest.chatHistory = request.chatHistory;
    }
  } else if (request.apiFormat === "GENERIC") {
    if (!request.messages || request.messages.length === 0) {
      throw new OciNativeError("Generic format requires `messages[]`");
    }
    chatRequest.messages = request.messages.map((m) => ({
      role: m.role.toUpperCase(),
      content: [{ type: "TEXT", text: m.content }],
    }));
  }
  if (request.extras) {
    Object.assign(chatRequest, request.extras);
  }
  return {
    compartmentId: request.compartmentId,
    servingMode: {
      modelId: request.modelId,
      servingType: request.servingType ?? "ON_DEMAND",
    },
    chatRequest,
  };
}

function parseNativeChatResponse(json: Record<string, unknown>): OciNativeChatResponse {
  // OCI's response shape varies by api-format; this is the common subset.
  // For COHERE: chatResponse.text + chatResponse.finishReason + meta.usage
  // For GENERIC: chatResponse.choices[0].message.content + finishReason
  const chatResponse = (json.chatResponse ?? {}) as Record<string, unknown>;
  const usage = ((json.modelResponse as Record<string, unknown>)?.usage ?? {}) as {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  const text = (chatResponse.text as string | undefined) ?? extractGenericText(chatResponse) ?? "";
  const finishReason =
    (chatResponse.finishReason as string | undefined) ?? extractGenericFinishReason(chatResponse);
  return {
    text,
    finishReason,
    usage: {
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
    raw: json,
  };
}

function extractGenericText(chatResponse: Record<string, unknown>): string | undefined {
  const choices = chatResponse.choices as
    | ReadonlyArray<{ message?: { content?: ReadonlyArray<{ text?: string; type?: string }> } }>
    | undefined;
  const first = choices?.[0]?.message?.content?.find((c) => c.type === "TEXT");
  return first?.text;
}

function extractGenericFinishReason(chatResponse: Record<string, unknown>): string | undefined {
  const choices = chatResponse.choices as ReadonlyArray<{ finishReason?: string }> | undefined;
  return choices?.[0]?.finishReason;
}
