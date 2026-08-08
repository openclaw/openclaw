import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
  type AiTransportHost,
} from "../host.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { Context, Model } from "../types.js";
import { createAnthropicEndpointAuthority } from "./anthropic-stream-terminal.js";
import { streamAnthropic } from "./anthropic.js";

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  apiKey?: string;
};

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(overrides: Partial<Model<"anthropic-messages">>) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

function serializeSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function createStandaloneDoneBody(done = "[DONE]"): string {
  return `${serializeSse([
    {
      type: "message_start",
      message: {
        id: "msg_standalone_done",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  ])}data: ${done}\n\n`;
}

function createOpenRawSseResponse(params: {
  body: string;
  onCancel: () => void;
  rejectCancel?: boolean;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        params.onCancel();
        if (params.rejectCancel) {
          throw new Error("cancel failed");
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function observeTestPhysicalDispatch(
  options: AiModelFetchOptions | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): void {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  options?.observeFetchDispatch?.({ url, init: init ?? {} });
}

async function runTerminalCompletenessCase(params: {
  enableBlockingGuard?: boolean;
  endpointClass: "anthropic-public" | "custom";
  events: Record<string, unknown>[];
  modelId?: string;
  onPayload?: NonNullable<Parameters<typeof streamAnthropic>[2]>["onPayload"];
  provider?: string;
  rawBody?: string;
  requestId?: string;
  transportEvents?: AiModelTransportEvent[];
}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(params.rawBody ?? serializeSse(params.events));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const model = makeModel({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ...(params.modelId ? { id: params.modelId } : {}),
    provider: params.provider ?? "anthropic",
  });
  const buildAttestedFetch = (
    _model: Model,
    _timeout: number | undefined,
    options: AiModelFetchOptions | undefined,
  ) => ({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      observeTestPhysicalDispatch(options, input, init);
      const response = globalThis.fetch(input, init);
      options?.onFetchDispatch?.();
      return await response;
    },
    provenance: "dispatch_attested" as const,
  });
  configureAiTransportHost({
    buildModelFetchWithDispatchAttestation: buildAttestedFetch,
    ...(params.enableBlockingGuard
      ? { buildModelFetchWithBlockingDispatchGuard: buildAttestedFetch }
      : {}),
    ...(params.transportEvents
      ? {
          observeModelTransportEvent: (event) => params.transportEvents?.push(event),
        }
      : {}),
    resolveProviderEndpointClass: () => params.endpointClass,
  });

  try {
    return await streamAnthropic(model, context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      ...(params.onPayload ? { onPayload: params.onPayload } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
    }).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  configureAiTransportHost({});
});

describe("Anthropic SDK host fetch wiring", () => {
  it("requires message_stop when any physical authority hop is unknown", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: (url) =>
        url === "https://compatible.example/v1/messages" ? "custom" : "",
    });

    authority.observePhysicalDispatch("https://unknown.example/v1/messages");
    authority.observePhysicalDispatch("https://compatible.example/v1/messages");

    expect(authority.snapshot()).toEqual({
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it("routes every non-Cloudflare client branch through the host fetch", async () => {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "test rejection" },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hostFetch = vi.fn<typeof fetch>((input, init) => globalThis.fetch(input, init));
    const buildModelFetch = vi.fn(() => hostFetch);
    configureAiTransportHost({ buildModelFetch });

    const cases = [
      {
        model: makeModel({ provider: "github-copilot", baseUrl }),
        apiKey: "copilot-token",
      },
      {
        model: makeModel({ provider: "microsoft-foundry", baseUrl, authHeader: true }),
        apiKey: "foundry-token",
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-oat01-oauth-token", // pragma: allowlist secret
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        model: makeModel({ provider: "kimi-coding", baseUrl }),
        apiKey: "kimi-api-key",
        thinkingEnabled: true,
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await streamAnthropic(testCase.model, context, {
          apiKey: testCase.apiKey,
          maxRetries: 0,
          thinkingEnabled: testCase.thinkingEnabled,
        }).result();
        expect(result.stopReason).toBe("error");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(hostFetch).toHaveBeenCalledTimes(cases.length);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer copilot-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer foundry-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer sk-ant-oat01-oauth-token", // pragma: allowlist secret
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "kimi-api-key",
      },
    ]);
    expect(buildModelFetch).toHaveBeenLastCalledWith(
      cases.at(-1)?.model,
      undefined,
      expect.objectContaining({ sanitizeSse: false }),
    );
  });

  it("counts each SDK retry at guarded fetch dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after-ms": "0",
        });
        response.end(JSON.stringify({ error: { message: "retry" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_retry",
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    const buildModelFetchWithDispatchAttestation: NonNullable<
      AiTransportHost["buildModelFetchWithDispatchAttestation"]
    > = (_model, _timeout, options?: AiModelFetchOptions) => {
      return {
        fetch: async (input, init) => {
          observeTestPhysicalDispatch(options, input, init);
          const response = globalThis.fetch(input, init);
          options?.onFetchDispatch?.();
          return await response;
        },
        provenance: "dispatch_attested",
      };
    };
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation,
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 1,
        requestId: "call-sdk-retry",
      }).result();
      expect(result.stopReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      }),
    ]);
  });

  it("records zero submission when owned SDK preflight fails before dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => {
        const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
          observeTestPhysicalDispatch(options, input, init);
          const response = hostFetch(input, init);
          options?.onFetchDispatch?.();
          return await response;
        };
        return { fetch: fetchImpl, provenance: "dispatch_attested" as const };
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-preflight",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-preflight",
        scope: "transport_semantics",
        reason: "transport_endpoint_authority_partial",
      }),
      expect.objectContaining({
        type: "submission",
        callId: "call-sdk-preflight",
        total: 0,
        outcome: "failed",
      }),
    ]);
  });

  it("keeps SDK dispatch provenance local when one fetch is reused", async () => {
    const events: AiModelTransportEvent[] = [];
    const sharedFetch = vi.fn<typeof fetch>();
    const buildAttestedModelFetch = vi
      .fn()
      .mockReturnValueOnce({
        fetch: sharedFetch,
        provenance: "dispatch_attested" as const,
      })
      .mockReturnValueOnce(undefined);
    configureAiTransportHost({
      buildModelFetch: () => sharedFetch,
      buildModelFetchWithDispatchAttestation: buildAttestedModelFetch,
      observeModelTransportEvent: (event) => events.push(event),
    });

    const attested = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-attested-shared-fetch",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();
    const bare = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-bare-shared-fetch",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();

    expect(attested.stopReason).toBe("error");
    expect(bare.stopReason).toBe("error");
    expect(sharedFetch).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-attested-shared-fetch",
        reason: "transport_endpoint_authority_partial",
      }),
      expect.objectContaining({
        type: "submission",
        callId: "call-sdk-attested-shared-fetch",
        total: 0,
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-bare-shared-fetch",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("does not count a synchronous owned SDK fetch throw as a dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>(() => {
      throw new Error("fetch invocation failed");
    });
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options?: AiModelFetchOptions) => (input, init) => {
        observeTestPhysicalDispatch(options, input, init);
        const response = hostFetch(input, init);
        options?.onFetchDispatch?.();
        return response;
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      requestId: "call-sdk-sync-fetch-throw",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-sync-fetch-throw",
        scope: "transport_semantics",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("records a failed owned SDK attempt when EOF arrives before message_stop", async () => {
    const events: AiModelTransportEvent[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_incomplete",
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestPhysicalDispatch(options, input, init);
          const response = globalThis.fetch(input, init);
          options.onFetchDispatch?.();
          return await response;
        },
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-incomplete",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("ended before message_stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-incomplete",
        outcome: "failed",
        statusCode: 200,
      }),
    ]);
  });

  it.each([
    {
      label: "rejects direct EOF after a mapped stop reason",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects official-endpoint EOF through a provider alias",
      endpointClass: "anthropic-public" as const,
      provider: "provider-alias",
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible EOF after a mapped stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_mapped_eof",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "stop",
    },
    {
      label: "rejects boundary-aligned compatible EOF without terminal evidence",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_eof",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "complete" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible clean EOF for refusal-buffered models",
      endpointClass: "custom" as const,
      modelId: "claude-opus-5",
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_refusal_buffer_eof",
            model: "claude-opus-5",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "must remain buffered" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible standalone DONE",
      endpointClass: "custom" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "stop",
    },
    {
      label: "rejects official standalone DONE",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible partial EOF without a stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects message_stop without a terminal message_delta",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_without_delta",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a reused content block index on a compatible endpoint",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_reused_block_index",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a truncated model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_tail_prefix",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta"`,
      expectedStopReason: "error",
    },
    {
      label: "rejects a complete model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_unknown_envelope",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hidden"}}\n\n`,
      expectedStopReason: "error",
    },
    {
      label: "ignores an identifiable truncated unlabelled ping",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_ping_tail",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}data: {"type":"ping"`,
      expectedStopReason: "stop",
    },
    {
      label: "rejects an SSE envelope whose event name disagrees with its payload",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: 'event: message_start\ndata: {"type":"message_stop"}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects data-only Anthropic message frames",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'data: {"type":"message_start","message":{"id":"msg_data_only","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a final bare event field that clears the event name",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event: message_start\nevent\ndata: {"type":"message_start","message":{"id":"msg_bare_event","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
  ])(
    "$label",
    async ({ endpointClass, events, expectedStopReason, modelId, provider, rawBody }) => {
      const result = await runTerminalCompletenessCase({
        endpointClass,
        events,
        modelId,
        provider,
        rawBody,
      });

      expect(result.stopReason).toBe(expectedStopReason);
      if (expectedStopReason === "error") {
        expect(result.errorMessage).toContain("ended before message_stop");
      }
    },
  );

  it.each([
    { label: "truncated JSON", data: '{"type":' },
    {
      label: "a malformed escape that JSON repair could normalize",
      data: '{"type":"vendor_ping","path":"C:\\q"}',
    },
  ])(
    "does not let a later terminal frame launder $label under an unknown envelope",
    async ({ data }) => {
      const rawBody = `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_unknown_malformed",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ])}event: vendor_ping\ndata: ${data}\n\n${serializeSse([
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])}`;

      const result = await runTerminalCompletenessCase({
        endpointClass: "custom",
        events: [],
        rawBody,
      });

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    },
  );

  it("rejects compatible clean EOF after an otherwise complete content block", async () => {
    const events: AiModelTransportEvent[] = [];
    const body = serializeSse([
      {
        type: "message_start",
        message: {
          id: "msg_compatible_eof",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "complete" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestPhysicalDispatch(options, input, init);
          options.onFetchDispatch?.();
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: "https://compatible.example" }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-compatible-clean-eof",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-compatible-clean-eof",
        outcome: "failed",
      }),
    ]);
  });

  it.each([
    { endpointClass: "custom" as const, expectedOutcome: "completed", expectedStop: "stop" },
    {
      endpointClass: "anthropic-public" as const,
      expectedOutcome: "failed",
      expectedStop: "error",
    },
  ])(
    "cancels open SDK DONE streams and records $expectedOutcome accounting",
    async ({ endpointClass, expectedOutcome, expectedStop }) => {
      const events: AiModelTransportEvent[] = [];
      const onCancel = vi.fn();
      configureAiTransportHost({
        buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
          fetch: async (input, init) => {
            observeTestPhysicalDispatch(options, input, init);
            options.onFetchDispatch?.();
            return createOpenRawSseResponse({
              body: `${createStandaloneDoneBody()}event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ignored"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
              onCancel,
            });
          },
          provenance: "dispatch_attested",
        }),
        observeModelTransportEvent: (event) => events.push(event),
        resolveProviderEndpointClass: () => endpointClass,
      });

      const result = await streamAnthropic(makeModel({}), context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: `call-sdk-done-${endpointClass}`,
      }).result();

      expect(result.stopReason).toBe(expectedStop);
      expect(onCancel).toHaveBeenCalledOnce();
      expect(events).toEqual([
        expect.objectContaining({
          type: "attempt",
          callId: `call-sdk-done-${endpointClass}`,
          outcome: expectedOutcome,
          statusCode: 200,
        }),
      ]);
    },
  );

  it("does not let SDK stream cancellation failure override compatible DONE", async () => {
    const onCancel = vi.fn();
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestPhysicalDispatch(options, input, init);
          options.onFetchDispatch?.();
          return createOpenRawSseResponse({
            body: createStandaloneDoneBody(),
            onCancel,
            rejectCancel: true,
          });
        },
        provenance: "dispatch_attested",
      }),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "success",
      stopReason: "end_turn",
      stopDetails: undefined,
      expectedStopReason: "stop",
      expectedOutcome: "completed",
    },
    {
      label: "refusal",
      stopReason: "refusal",
      stopDetails: {
        type: "refusal",
        category: "cyber",
        explanation: "This request is not allowed.",
      },
      expectedStopReason: "error",
      expectedOutcome: "failed",
    },
  ])(
    "records owned SDK no-boundary fallback $label as one attempt and one transition",
    async ({ expectedOutcome, expectedStopReason, label, stopDetails, stopReason }) => {
      const events: AiModelTransportEvent[] = [];
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: `msg_fallback_${label}`,
                model: "claude-opus-5",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: {
                stop_reason: stopReason,
                ...(stopDetails ? { stop_details: stopDetails } : {}),
              },
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                iterations: [
                  {
                    type: "fallback_message",
                    model: "claude-opus-5",
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_creation: null,
                  },
                ],
              },
            },
            { type: "message_stop" },
          ]),
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address() as AddressInfo;
      const loopbackUrl = `http://127.0.0.1:${address.port}/v1/messages`;
      const buildFallbackFetch = (
        _model: Model,
        _timeout: number | undefined,
        options?: AiModelFetchOptions & {
          beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        },
      ): typeof fetch => {
        return async (input, init) => {
          const dispatch = {
            url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
            init: init ?? {},
          };
          options?.beforeFetchDispatch?.(dispatch);
          observeTestPhysicalDispatch(options, input, init);
          const response = globalThis.fetch(loopbackUrl, init);
          options?.onFetchDispatch?.();
          return await response;
        };
      };
      configureAiTransportHost({
        buildModelFetch: buildFallbackFetch,
        buildModelFetchWithBlockingDispatchGuard: (...args) => ({
          fetch: buildFallbackFetch(...args),
          provenance: "dispatch_attested",
        }),
        observeModelTransportEvent: (event) => events.push(event),
        resolveProviderEndpointClass: (baseUrl) =>
          baseUrl?.startsWith("https://api.anthropic.com") ? "anthropic-public" : "custom",
      });
      const requestId = `call-sdk-fallback-${label}`;

      try {
        const result = await streamAnthropic(
          makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
          context,
          {
            apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
            maxRetries: 0,
            requestId,
          },
        ).result();
        expect(result.stopReason).toBe(expectedStopReason);
        expect(result.responseModel).toBe("claude-opus-5");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      expect(requestCount).toBe(1);
      expect(events).toEqual([
        expect.objectContaining({
          type: "provider_fallback",
          callId: requestId,
          fromModel: "claude-fable-5",
          toModel: "claude-opus-5",
        }),
        expect.objectContaining({
          type: "attempt",
          callId: requestId,
          ordinal: 1,
          outcome: expectedOutcome,
          statusCode: 200,
        }),
      ]);
    },
  );

  it("preserves SDK no-boundary fallback identity when the stream ends incomplete", async () => {
    const events: AiModelTransportEvent[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_sdk_incomplete_fallback",
              model: "claude-opus-5",
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              iterations: [{ type: "fallback_message", model: "claude-opus-5" }],
            },
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const loopbackUrl = `http://127.0.0.1:${address.port}/v1/messages`;
    const buildFallbackFetch = (
      _model: Model,
      _timeout: number | undefined,
      options?: AiModelFetchOptions & {
        beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
      },
    ): typeof fetch => {
      return async (input, init) => {
        const dispatch = {
          url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
          init: init ?? {},
        };
        options?.beforeFetchDispatch?.(dispatch);
        observeTestPhysicalDispatch(options, input, init);
        const response = globalThis.fetch(loopbackUrl, init);
        options?.onFetchDispatch?.();
        return await response;
      };
    };
    configureAiTransportHost({
      buildModelFetch: buildFallbackFetch,
      buildModelFetchWithBlockingDispatchGuard: (...args) => ({
        fetch: buildFallbackFetch(...args),
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: (baseUrl) =>
        baseUrl?.startsWith("https://api.anthropic.com") ? "anthropic-public" : "custom",
    });
    const model = makeModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-incomplete-fallback",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.responseModel).toBe("claude-opus-5");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          type: "provider_fallback",
          details: {
            provider: "anthropic",
            fromModel: "claude-fable-5",
            toModel: "claude-opus-5",
          },
        }),
      ]);
      expect(result.usage.cost.total).toBeCloseTo(0.000075, 10);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        callId: "call-sdk-incomplete-fallback",
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-incomplete-fallback",
        outcome: "failed",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-incomplete-fallback",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });
});
