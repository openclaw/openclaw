import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost } from "../host.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolCall,
} from "../types.js";
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

function sseResponse(body: BodyInit): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function mockSse(body: BodyInit): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(body)),
  );
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

  it("exposes cumulative tool input before the provider completes the call", async ({
    onTestFinished,
  }) => {
    const gate = createDeferred();
    onTestFinished(() => gate.resolve());
    const encoder = new TextEncoder();
    mockSse(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'data: {"event_type":"step.start","step":{"type":"function_call","id":"progress","name":"write","arguments":{}}}\n\n',
                'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"content\\":\\"line"}}\n\n',
              ].join(""),
            ),
          );
          await gate.promise;
          controller.enqueue(
            encoder.encode(
              [
                'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":" end\\"}"}}\n\n',
                'data: {"event_type":"step.stop"}\n\n',
                completedSse({ status: "requires_action" }),
              ].join(""),
            ),
          );
          controller.close();
        },
      }),
    );
    const stream = streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: crypto.randomUUID(),
    });
    let firstInput: unknown;
    try {
      for await (const event of stream) {
        if (event.type === "toolcall_delta" && firstInput === undefined) {
          firstInput = structuredClone(event.partial.content[event.contentIndex]);
          gate.resolve();
        }
      }
    } finally {
      gate.resolve();
    }
    expect(firstInput).toMatchObject({ partialJson: '{"content":"line' });
    expect((await stream.result()).content).toEqual([
      { type: "toolCall", id: "progress", name: "write", arguments: { content: "line end" } },
    ]);
  });

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

    mockSse(stream);

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    const events: AssistantMessageEvent[] = [];
    for await (const event of eventStream) {
      events.push(event);
      if (event.type === "start" || event.type === "text_end") {
        expect(event.partial.api).toBe("google-interactions");
      } else if (event.type === "text_delta") {
        expect(event.partial?.api).toBe("google-interactions");
      } else if (event.type === "done") {
        expect(event.message.api).toBe("google-interactions");
      }
    }

    expect(cancelCalled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(events[0]?.type).toBe("start");
    const doneEvent = events.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it.each([
    { provider: "google", geminiKey: "env-resolved-gemini-key", simple: false },
    { provider: "google-interactions", geminiKey: "env-resolved-gemini-key", simple: false },
    { provider: "google-interactions", geminiKey: "", simple: true },
  ])(
    "resolves environment auth for $provider (simple=$simple)",
    async ({ provider, geminiKey, simple }) => {
      vi.stubEnv("GEMINI_API_KEY", geminiKey);
      vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
      let capturedHeaders: HeadersInit | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          capturedHeaders = init?.headers;
          return sseResponse(completedSse() + "data: [DONE]\n\n");
        }),
      );
      await (
        simple
          ? streamSimpleGoogleInteractions(makeInteractionsModel(provider), basicContext)
          : streamGoogleInteractions(makeInteractionsModel(provider), basicContext, {})
      ).result();
      expect(capturedHeaders).toBeDefined();
      expect(new Headers(capturedHeaders).get("x-goog-api-key")).toBe(
        geminiKey || "google-fallback-key",
      );
    },
  );

  it("preserves streamed text, thought signatures, and tool arguments", async () => {
    const cases: Array<{
      frames: string[];
      content: AssistantMessage["content"];
      toolUse?: boolean;
    }> = [
      {
        frames: [
          'data: {"event_type":"step.start","step":{"type":"thought","summary":[{"type":"text","text":"Reasoning about tool..."}]}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"sig_stream_thought=="}}\n\n',
          'data: {"event_type":"step.stop"}\n\n',
          'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_99","name":"search","arguments":{"q":"gemini"}}}\n\n',
        ],
        toolUse: true,
        content: [
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
        ],
      },
      {
        frames: [
          'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"Hello"}]}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"text","text":" world"}}\n\n',
        ],
        content: [{ type: "text", text: "Hello world" }],
      },
      {
        frames: [
          'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"command\\":\\"ls "}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"-la\\"}"}}\n\n',
        ],
        toolUse: true,
        content: [
          {
            type: "toolCall",
            id: "call_exec_1",
            name: "exec",
            arguments: { command: "ls -la" },
          },
        ],
      },
      {
        frames: [
          'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{}}}\n\n',
          'data: {"event_type":"step.delta","delta":{"type":"arguments_delta","arguments":"{\\"target\\":9223372036854775807}"}}\n\n',
        ],
        toolUse: true,
        content: [
          {
            type: "toolCall",
            id: "call_exec_1",
            name: "exec",
            arguments: { target: "9223372036854775807" },
          },
        ],
      },
      {
        frames: [
          'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_exec_1","name":"exec","arguments":{"target":9223372036854775807}}}\n\n',
        ],
        toolUse: true,
        content: [
          {
            type: "toolCall",
            id: "call_exec_1",
            name: "exec",
            arguments: { target: "9223372036854775807" },
          },
        ],
      },
    ];
    for (const { frames, content, toolUse } of cases) {
      mockSse(
        frames.join("") +
          'data: {"event_type":"step.stop"}\n\n' +
          completedSse({ status: toolUse ? "requires_action" : "completed" }) +
          "data: [DONE]\n\n",
      );
      const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
        apiKey: "test-key",
      }).result();
      expect(result.content).toEqual(content);
      expect(result.stopReason).toBe(toolUse ? "toolUse" : "stop");
      const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
      expect(toolCall?.thoughtSignature).toBeUndefined();
    }
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

      mockSse(body);

      try {
        const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
          apiKey: "test-key",
        }).result();

        expect(result).toMatchObject({
          stopReason: "error",
          errorCode: "malformed_tool_call_arguments",
          errorMessage: "Provider completed tool call with malformed JSON arguments",
        });
        expect(result.content[0]).not.toHaveProperty("partialJson");
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
        expect(pendingWork).toHaveLength(1);
      } finally {
        cancellation.resolve();
        await Promise.all(pendingWork);
      }
    },
  );

  it("resolves sentinels before guarded egress and keeps request diagnostics secret-free", async () => {
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    const diagnostics: unknown[] = [];
    const guardedFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("resolved-secret");
      expect(headers.Authorization).toBe("Bearer resolved-secret");
      expect(headers["X-Option-Auth"]).toBe("resolved-secret");
      return sseResponse(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"));
    });
    configureAiTransportHost({
      buildModelFetch: () => guardedFetch as typeof fetch,
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "resolved-secret"),
      logDebug: (_subsystem, build) => diagnostics.push(build()),
    });

    const result = await streamGoogleInteractions(
      { ...makeInteractionsModel(), headers: { Authorization: `Bearer ${sentinel}` } },
      basicContext,
      { apiKey: sentinel, headers: { "X-Option-Auth": sentinel } },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("resolved-secret");
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Hello");
    expect(serialized).toContain('"message":"request"');
  });

  it("surfaces a streamed provider error instead of completing successfully", async () => {
    mockSse(
      new TextEncoder().encode(
        'data: {"event_type":"error","error":{"message":"deadline expired","code":"gateway_timeout"}}\n\n',
      ),
    );

    const result = await streamGoogleInteractions(makeInteractionsModel(), basicContext, {
      apiKey: "test-api-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("deadline expired");
    expect(result.errorCode).toBe("gateway_timeout");
  });

  it.each(["completion", "step.stop"])("maps cumulative %s usage and costs", async (source) => {
    const cumulativeUsage = {
      total_input_tokens: 100,
      total_cached_tokens: 40,
      total_output_tokens: 20,
      total_thought_tokens: 30,
      total_tool_use_tokens: 5,
      total_tokens: 155,
    };
    mockSse(
      new TextEncoder().encode(
        (source === "step.stop"
          ? `data: ${JSON.stringify({ event_type: "step.stop", usage: cumulativeUsage })}\n\n` +
            completedSse({ usage: null })
          : completedSse({ usage: cumulativeUsage })) + "data: [DONE]\n\n",
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
      cacheTelemetry: { state: "available" },
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
      modelId: "gemini-2.5-flash",
      reasoning: "xhigh" as const,
      expected: { thinking_level: "high", thinking_summaries: "auto" },
    },
    {
      modelId: "gemini-2.5-flash",
      reasoning: "max" as const,
      expected: { thinking_level: "high", thinking_summaries: "auto" },
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
          return sseResponse(new TextEncoder().encode(completedSse() + "data: [DONE]\n\n"));
        }),
      );

      await streamSimpleGoogleInteractions(
        {
          ...makeInteractionsModel(),
          id: modelId,
          reasoning: true,
          thinkingLevelMap: { xhigh: "high", max: "high" },
        },
        basicContext,
        { apiKey: "test-api-key", reasoning },
      ).result();

      expect(requestBody?.generation_config).toEqual(expected);
    },
  );
});
