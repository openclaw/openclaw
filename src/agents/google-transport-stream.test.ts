import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

vi.mock("./provider-transport-fetch.js", () => ({
  buildGuardedModelFetch: buildGuardedModelFetchMock,
}));

let buildGoogleGenerativeAiParams: typeof import("./google-transport-stream.js").buildGoogleGenerativeAiParams;
let createGoogleGenerativeAiTransportStreamFn: typeof import("./google-transport-stream.js").createGoogleGenerativeAiTransportStreamFn;

function buildGeminiModel(
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

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
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

describe("google transport stream", () => {
  beforeAll(async () => {
    ({ buildGoogleGenerativeAiParams, createGoogleGenerativeAiTransportStreamFn } =
      await import("./google-transport-stream.js"));
  });

  beforeEach(() => {
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
  });

  it("uses the guarded fetch transport and parses Gemini SSE output", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          responseId: "resp_1",
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "draft", thoughtSignature: "sig_1" },
                  { text: "answer" },
                  { functionCall: { name: "lookup", args: { q: "hello" } } },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            cachedContentTokenCount: 2,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
          },
        },
      ]),
    );

    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        headers: { "X-Provider": "google" },
      } satisfies Model<"google-generative-ai">,
      {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          systemPrompt: "Follow policy.",
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: {
                type: "object",
                properties: { q: { type: "string" } },
                required: ["q"],
              },
            },
          ],
        } as unknown as Parameters<typeof streamFn>[1],
        {
          apiKey: "gemini-api-key",
          cachedContent: "cachedContents/request-cache",
          reasoning: "medium",
          toolChoice: "auto",
        } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
    expect(guardedFetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "text/event-stream",
          "Content-Type": "application/json",
          "x-goog-api-key": "gemini-api-key",
          "X-Provider": "google",
        }),
      }),
    );

    const init = guardedFetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = init.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected Google transport request body to be serialized JSON");
    }
    const payload = JSON.parse(requestBody) as Record<string, unknown>;
    expect(payload.systemInstruction).toEqual({
      parts: [{ text: "Follow policy." }],
    });
    expect(payload.cachedContent).toBe("cachedContents/request-cache");
    expect(payload.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
    });
    expect(payload.toolConfig).toMatchObject({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(result).toMatchObject({
      api: "google-generative-ai",
      provider: "google",
      responseId: "resp_1",
      stopReason: "toolUse",
      usage: {
        input: 8,
        output: 8,
        cacheRead: 2,
        totalTokens: 18,
      },
      content: [
        { type: "thinking", thinking: "draft", thinkingSignature: "sig_1" },
        { type: "text", text: "answer" },
        { type: "toolCall", name: "lookup", arguments: { q: "hello" } },
      ],
    });
  });

  it("uses bearer auth when the Google api key is an OAuth JSON payload", async () => {
    guardedFetchMock.mockResolvedValueOnce(buildSseResponse([]));

    const model = attachModelProviderRequestTransport(
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        api: "google-generative-ai",
        provider: "custom-google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      } satisfies Model<"google-generative-ai">,
      {
        tls: {
          ca: "ca-pem",
        },
      },
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        {
          apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }),
        } as Parameters<typeof streamFn>[2],
      ),
    );
    await stream.result();

    expect(guardedFetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("coerces replayed malformed tool-call args to an object for Google payloads", () => {
    const params = buildGoogleGenerativeAiParams(buildGeminiModel(), {
      messages: [
        {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: "{not valid json",
            },
          ],
        },
      ],
    } as never);

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [{ functionCall: { name: "lookup", args: {} } }],
    });
  });

  it("builds direct Gemini payloads without negative fallback thinking budgets", () => {
    const model = {
      id: "custom-gemini-model",
      name: "Custom Gemini",
      api: "google-generative-ai",
      provider: "custom-google",
      baseUrl: "https://proxy.example.com/gemini/v1beta",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } satisfies Model<"google-generative-ai">;

    const params = buildGoogleGenerativeAiParams(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        reasoning: "medium",
      },
    );

    expect(params.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true },
    });
    expect(params.generationConfig).not.toMatchObject({
      thinkingConfig: { thinkingBudget: -1 },
    });
  });

  it("captures thoughtSignature on tool-call parts from Gemini SSE responses", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      buildSseResponse([
        {
          responseId: "resp_sig",
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "exec", args: { cmd: "ls" } },
                    thoughtSignature: "sig_tool_1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        },
      ]),
    );

    const streamFn = createGoogleGenerativeAiTransportStreamFn();
    const stream = await Promise.resolve(
      streamFn(
        buildGeminiModel({ id: "gemini-3-flash-preview" }),
        {
          messages: [{ role: "user", content: "hi", timestamp: 0 }],
        } as Parameters<typeof streamFn>[1],
        { apiKey: "k" } as Parameters<typeof streamFn>[2],
      ),
    );
    const result = await stream.result();

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "toolCall",
        name: "exec",
        thoughtSignature: "sig_tool_1",
      }),
    ]);
  });

  it("re-emits thoughtSignature byte-exact on same-provider tool-call replays", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "google",
            api: "google-generative-ai",
            model: "gemini-3-flash-preview",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "exec",
                arguments: { cmd: "ls" },
                thoughtSignature: "sig_tool_1",
              },
            ],
          },
        ],
      } as never,
    );

    expect(params.contents[0]).toMatchObject({
      role: "model",
      parts: [
        {
          functionCall: { name: "exec", args: { cmd: "ls" } },
          thoughtSignature: "sig_tool_1",
        },
      ],
    });
  });

  it("omits thoughtSignature on tool-call replays when absent", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "google",
            api: "google-generative-ai",
            model: "gemini-3-flash-preview",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "exec",
                arguments: { cmd: "ls" },
              },
            ],
          },
        ],
      } as never,
    );

    const part = (params.contents[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(part).not.toHaveProperty("thoughtSignature");
  });

  it("drops thoughtSignature on tool-call replays when switching providers", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.4",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "exec",
                arguments: { cmd: "ls" },
                thoughtSignature: "sig_from_other_provider",
              },
            ],
          },
        ],
      } as never,
    );

    const part = (params.contents[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(part).not.toHaveProperty("thoughtSignature");
  });

  it("preserves thoughtSignature only on the parts that carried one in a parallel tool-call turn", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel({ id: "gemini-3-flash-preview" }),
      {
        messages: [
          {
            role: "assistant",
            provider: "google",
            api: "google-generative-ai",
            model: "gemini-3-flash-preview",
            stopReason: "toolUse",
            timestamp: 0,
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "exec",
                arguments: { cmd: "ls" },
                thoughtSignature: "sig_first_only",
              },
              {
                type: "toolCall",
                id: "call_2",
                name: "exec",
                arguments: { cmd: "pwd" },
              },
            ],
          },
        ],
      } as never,
    );

    const parts = (params.contents[0] as { parts: Array<Record<string, unknown>> }).parts;
    expect(parts[0]).toMatchObject({ thoughtSignature: "sig_first_only" });
    expect(parts[1]).not.toHaveProperty("thoughtSignature");
  });

  it("includes cachedContent in direct Gemini payloads when requested", () => {
    const params = buildGoogleGenerativeAiParams(
      buildGeminiModel(),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      } as never,
      {
        cachedContent: "cachedContents/prebuilt-context",
      },
    );

    expect(params.cachedContent).toBe("cachedContents/prebuilt-context");
  });
});
