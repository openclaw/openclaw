import type { Model } from "openclaw/plugin-sdk/llm";
import { expect } from "vitest";

const MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL = Symbol.for(
  "openclaw.modelProviderRequestTransport",
);

export function attachModelProviderRequestTransport<TModel extends object>(
  model: TModel,
  request: unknown,
): TModel {
  return {
    ...model,
    [MODEL_PROVIDER_REQUEST_TRANSPORT_SYMBOL]: request,
  };
}

export function buildGeminiModel(
  overrides: Partial<Model<"google-generative-ai">> = {},
): Model<"google-generative-ai"> {
  return {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function buildGoogleVertexModel(
  overrides: Partial<Model<"google-vertex">> = {},
): Model<"google-vertex"> {
  return {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return buildRawSseResponse(sse);
}

export function buildRawSseResponse(sse: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function buildOpenRawSseResponse(params: { sse: string; onCancel: () => void }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(params.sse));
    },
    cancel() {
      params.onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function buildDelayedSecondSseResponse(params: {
  first: unknown;
  second: unknown;
  delayMs: number;
}): Response {
  const encoder = new TextEncoder();
  const first = `data: ${JSON.stringify(params.first)}\n\n`;
  const second = `data: ${JSON.stringify(params.second)}\n\ndata: [DONE]\n\n`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      timeout = setTimeout(() => {
        controller.enqueue(encoder.encode(second));
        controller.close();
      }, params.delayMs);
    },
    cancel() {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function requireMockCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  index: number,
  label: string,
): TArgs {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected ${label} mock call ${index}`);
  }
  return call;
}

export function requireRequestInit(call: unknown[], label: string): RequestInit {
  const init = call[1];
  if (!init || typeof init !== "object") {
    throw new Error(`Expected ${label} request init`);
  }
  return init as RequestInit;
}

export function expectHeaders(init: RequestInit, expected: Record<string, string>): void {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(expected)) {
    expect(headers.get(key)).toBe(value);
  }
}

export function parseRequestJsonBody(init: RequestInit): Record<string, unknown> {
  const requestBody = init.body;
  if (typeof requestBody !== "string") {
    throw new Error("Expected request body to be serialized JSON");
  }
  return JSON.parse(requestBody) as Record<string, unknown>;
}

export function requireGenerationConfig(params: {
  generationConfig?: unknown;
}): Record<string, unknown> {
  const config = params.generationConfig;
  if (!config || typeof config !== "object") {
    throw new Error("Expected generationConfig");
  }
  return config as Record<string, unknown>;
}
