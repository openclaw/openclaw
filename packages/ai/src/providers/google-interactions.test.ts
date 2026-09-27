import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost } from "../host.js";
import type { AssistantMessage, Context, Model, ToolCall } from "../types.js";
import { streamGoogleInteractions, streamSimpleGoogleInteractions } from "./google-interactions.js";

const completedSse = (params?: {
  status?: string;
  usage?: Record<string, number> | null;
}): string =>
  `data: ${JSON.stringify({
    event_type: "interaction.completed",
    interaction: {
      status: params?.status ?? "completed",
      ...(params?.usage === null
        ? {}
        : {
            usage: params?.usage ?? {
              total_input_tokens: 1,
              total_output_tokens: 1,
              total_tokens: 2,
            },
          }),
    },
  })}\n\n`;

function makeInteractionsModel(provider = "google"): Model<"google-interactions"> {
  return {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    api: "google-interactions",
    provider,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("google-interactions provider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    configureAiTransportHost({});
  });

  const basicContext: Context = {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  };

  it("terminates outer stream loop immediately and cancels reader upon receiving data: [DONE]", async () => {
    let cancelCalled = false;
    const encoder = new TextEncoder();

    // ReadableStream that delivers a text delta and [DONE], then hangs forever unless cancelled
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"event_type":"step.delta","delta":{"type":"text","text":"Hello world"}}\n\n' +
              completedSse() +
              "data: [DONE]\n\n",
          ),
        );
      },
      cancel() {
        cancelCalled = true;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    const events: unknown[] = [];
    for await (const event of eventStream) {
      events.push(event);
    }

    expect(cancelCalled).toBe(true);
    expect(stream.locked).toBe(false);
    const doneEvent = events.find(
      (e): e is { type: "done"; message: { api: string; content: unknown[] } } =>
        Boolean(e && typeof e === "object" && (e as { type: string }).type === "done"),
    );
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("initializes assistant output with api='google-interactions' and emits events with matching api", async () => {
    const encoder = new TextEncoder();
    const ssePayload =
      'data: {"event_type":"step.delta","delta":{"type":"text","text":"Output test"}}\n\n' +
      completedSse() +
      "data: [DONE]\n\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(encoder.encode(ssePayload), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    const receivedEvents: Array<{ type: string; api?: string }> = [];
    for await (const event of eventStream) {
      if (event.type === "start") {
        receivedEvents.push({ type: "start", api: event.partial.api });
      } else if (event.type === "text_delta") {
        receivedEvents.push({ type: "text_delta", api: event.partial?.api });
      } else if (event.type === "text_end") {
        receivedEvents.push({ type: "text_end", api: event.partial.api });
      } else if (event.type === "done") {
        receivedEvents.push({ type: "done", api: event.message.api });
      }
    }

    expect(receivedEvents.length).toBeGreaterThan(0);
    expect(receivedEvents[0]?.type).toBe("start");
    for (const event of receivedEvents) {
      expect(event.api).toBe("google-interactions");
    }
  });

  it("resolves apiKey via getEnvApiKey(model.provider) when not provided in options", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-resolved-gemini-key");

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel("google");
    const eventStream = streamGoogleInteractions(model, basicContext, {});

    for await (const event of eventStream) {
      void event;
    }

    expect(capturedHeaders).toBeDefined();
    expect((capturedHeaders as Record<string, string>)["x-goog-api-key"]).toBe(
      "env-resolved-gemini-key",
    );
  });

  it("resolves apiKey from environment when model.provider is 'google-interactions'", async () => {
    vi.stubEnv("GEMINI_API_KEY", "interactions-provider-key");

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel("google-interactions");
    const eventStream = streamGoogleInteractions(model, basicContext, {});

    for await (const event of eventStream) {
      void event;
    }

    expect(capturedHeaders).toBeDefined();
    expect((capturedHeaders as Record<string, string>)["x-goog-api-key"]).toBe(
      "interactions-provider-key",
    );
  });

  it("uses GOOGLE_API_KEY through the registered simple stream", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    await streamSimpleGoogleInteractions(
      makeInteractionsModel("google-interactions"),
      basicContext,
    ).result();

    expect((capturedHeaders as Record<string, string>)["x-goog-api-key"]).toBe(
      "google-fallback-key",
    );
  });

  it("keeps thought signatures on thinking blocks and does not attach them to toolCall blocks in streaming", async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"thought","summary":[{"type":"text","text":"Reasoning about tool..."}]}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"sig_stream_thought=="}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_99","name":"search","arguments":{"q":"gemini"}}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      completedSse({ status: "requires_action" }),
      "data: [DONE]\n\n",
    ].join("");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(encoder.encode(ssePayload), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    let doneMessage: AssistantMessage | null = null;
    for await (const event of eventStream) {
      if (event.type === "done") {
        doneMessage = event.message;
      }
    }

    expect(doneMessage).toBeDefined();
    expect(doneMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: "Reasoning about tool...",
        thinkingSignature: "sig_stream_thought==",
      },
      {
        type: "toolCall",
        id: "call_99",
        name: "search",
        arguments: { q: "gemini" },
      },
    ]);
    const toolCall = doneMessage?.content.find((c): c is ToolCall => c.type === "toolCall");
    expect(toolCall?.thoughtSignature).toBeUndefined();
  });

  it("preserves model output text from step.start before appending text deltas", async () => {
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Hello"}]}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"text","text":" world"}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      completedSse(),
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new TextEncoder().encode(ssePayload), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-key",
    }).result();

    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("accumulates tool call arguments streamed across arguments_delta events", async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"command\\":\\"ls "}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"-la\\"}"}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      completedSse({ status: "requires_action" }),
      "data: [DONE]\n\n",
    ].join("");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(encoder.encode(ssePayload), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    let doneMessage: AssistantMessage | null = null;
    for await (const event of eventStream) {
      if (event.type === "done") {
        doneMessage = event.message;
      }
    }

    expect(doneMessage).toBeDefined();
    expect(doneMessage?.content).toEqual([
      {
        type: "toolCall",
        id: "call_exec_1",
        name: "exec",
        arguments: { command: "ls -la" },
      },
    ]);
  });

  it("preserves unsafe integers in streamed tool call arguments", async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"target\\":9223372036854775807}"}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      completedSse({ status: "requires_action" }),
      "data: [DONE]\n\n",
    ].join("");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(encoder.encode(ssePayload), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-key",
    }).result();

    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call_exec_1",
        name: "exec",
        arguments: { target: "9223372036854775807" },
      },
    ]);
  });

  it("preserves unsafe integers in initial streamed tool call arguments", async () => {
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{"target":9223372036854775807}}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      completedSse({ status: "requires_action" }),
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new TextEncoder().encode(ssePayload), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-key",
    }).result();

    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call_exec_1",
        name: "exec",
        arguments: { target: "9223372036854775807" },
      },
    ]);
  });

  it.each(["resolved", "rejected", "pending"])(
    "retires malformed tool streams when cancellation is %s",
    async (cancellationState) => {
      const encoder = new TextEncoder();
      const ssePayload = [
        'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
        'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"command\\":\\"ls"}}\n\n',
        'data: {"event_type":"step.stop"}\n\n',
      ].join("");
      const cancellation = createDeferred();
      const pendingWork: Promise<unknown>[] = [];
      configureAiTransportHost({
        observePendingProviderWork: (pending) => {
          pendingWork.push(pending);
        },
      });
      const cancel = vi.fn(() => {
        if (cancellationState === "resolved") {
          cancellation.resolve();
        } else if (cancellationState === "rejected") {
          cancellation.reject(new Error("cancel failed"));
        }
        return cancellation.promise;
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(ssePayload));
        },
        cancel,
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
        ),
      );

      try {
        const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
          apiKey: "test-key",
        }).result();

        expect(result).toMatchObject({
          stopReason: "error",
          errorCode: "malformed_tool_call_arguments",
          errorMessage: "Provider completed tool call with malformed JSON arguments",
        });
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(pendingWork).toHaveLength(1);
      } finally {
        cancellation.resolve();
        await Promise.all(pendingWork);
      }
    },
  );

  it("resolves API-key and custom-header sentinels before guarded egress", async () => {
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const guardedFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("resolved-secret");
      expect(headers.Authorization).toBe("Bearer resolved-secret");
      return new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    configureAiTransportHost({
      buildModelFetch: () => guardedFetch as typeof fetch,
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "resolved-secret"),
    });

    const result = await streamGoogleInteractions(
      { ...makeInteractionsModel(), headers: { Authorization: `Bearer ${sentinel}` } },
      basicContext,
      { apiKey: sentinel },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledOnce();
  });

  it("routes bounded request diagnostics through the host logger without payloads or headers", async () => {
    const diagnostics: unknown[] = [];
    configureAiTransportHost({
      logDebug: (_subsystem, build) => diagnostics.push(build()),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );

    await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "diagnostic-secret",
      headers: { Authorization: "Bearer diagnostic-secret" },
    }).result();

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("diagnostic-secret");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Hello");
    expect(serialized).toContain('"message":"request"');
  });

  it("surfaces a streamed provider error instead of completing successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new TextEncoder().encode(
              'data: {"event_type":"error","error":{"message":"deadline expired","code":"gateway_timeout"}}\n\n',
            ),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-api-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("deadline expired");
    expect(result.errorCode).toBe("gateway_timeout");
  });

  it("maps cached, thought, and tool-use tokens into canonical usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new TextEncoder().encode(
              completedSse({
                usage: {
                  total_input_tokens: 100,
                  total_cached_tokens: 40,
                  total_output_tokens: 20,
                  total_thought_tokens: 30,
                  total_tool_use_tokens: 5,
                  total_tokens: 155,
                },
              }) + "data: [DONE]\n\n",
            ),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-api-key",
    }).result();

    expect(result.usage).toMatchObject({
      input: 65,
      output: 50,
      cacheRead: 40,
      totalTokens: 155,
      cacheTelemetry: { state: "available" },
    });
  });

  it("retains cumulative step-stop usage when completion omits usage", async () => {
    const cumulativeUsage = {
      total_input_tokens: 100,
      total_cached_tokens: 40,
      total_output_tokens: 20,
      total_thought_tokens: 30,
      total_tool_use_tokens: 5,
      total_tokens: 155,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ event_type: "step.stop", usage: cumulativeUsage })}\n\n` +
                completedSse({ usage: null }) +
                "data: [DONE]\n\n",
            ),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );

    const model = {
      ...makeInteractionsModel(),
      cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
    };
    const result = await streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    }).result();

    expect(result.usage).toMatchObject({
      input: 65,
      output: 50,
      cacheRead: 40,
      totalTokens: 155,
      cost: {
        input: 0.000065,
        output: 0.0001,
        cacheRead: 0.00001,
        total: 0.000175,
      },
    });
  });

  it.each([
    {
      modelId: "gemini-2.5-flash",
      reasoning: "low" as const,
      expected: { thinking_level: "low", thinking_summaries: "auto" },
    },
    {
      modelId: "gemini-3-flash-preview",
      reasoning: "off" as const,
      expected: { thinking_level: "minimal", thinking_summaries: "none" },
    },
    {
      modelId: "gemini-3-flash-preview",
      reasoning: "adaptive" as never,
      expected: { thinking_summaries: "auto" },
    },
  ])(
    "maps $modelId reasoning=$reasoning into the request",
    async ({ modelId, reasoning, expected }) => {
      let requestBody: Record<string, unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (typeof init?.body !== "string") {
            throw new Error("expected serialized Interactions request body");
          }
          requestBody = JSON.parse(init.body);
          return new Response(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }),
      );

      await streamSimpleGoogleInteractions(
        { ...makeInteractionsModel(), id: modelId, reasoning: true },
        basicContext,
        { apiKey: "test-api-key", reasoning },
      ).result();

      expect(requestBody?.generation_config).toEqual(expected);
    },
  );
});
