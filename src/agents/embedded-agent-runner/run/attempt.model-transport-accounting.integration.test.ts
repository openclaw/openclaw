import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import {
  configureAiTransportHost,
  createApiRegistry,
  getAiTransportHost,
  type Context,
  type Model,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import {
  createAnthropicMessagesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../llm/ai-transport-host.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { attachModelProviderRequestTransport } from "../../provider-request-config.js";
import {
  createProviderTransportAccountingCollector,
  runWithProviderTransportAccountingObserver,
} from "../../provider-transport-accounting.js";
import { buildGuardedModelFetch } from "../../provider-transport-fetch.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const initialHost = getAiTransportHost();

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const context = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
} satisfies Context;

const chatGptModel = {
  ...model,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
} satisfies Model<"openai-chatgpt-responses">;

const anthropicModel = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
} satisfies Model<"anthropic-messages">;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completedSseResponse(options: { includeAuthority?: boolean } = {}): Response {
  const includeAuthority = options.includeAuthority !== false;
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_collector",
        status: "completed",
        ...(includeAuthority
          ? {
              model: model.id,
              headers: { "openai-model": model.id },
            }
          : {}),
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // Drain the stream so diagnostic and transport terminal events settle.
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function wrapOpenAIStream(callId: string): StreamFn {
  return wrapStreamFnWithDiagnosticModelCallEvents(createOpenAIResponsesTransportStreamFn(), {
    runId: `run-${callId}`,
    provider: model.provider,
    model: model.id,
    api: model.api,
    transport: "responses-sdk",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => callId,
  });
}

function wrapAnthropicStream(
  callId: string,
  selectedModel: Model<"anthropic-messages"> = anthropicModel,
): StreamFn {
  return wrapStreamFnWithDiagnosticModelCallEvents(createAnthropicMessagesTransportStreamFn(), {
    runId: `run-${callId}`,
    provider: selectedModel.provider,
    model: selectedModel.id,
    api: selectedModel.api,
    transport: "sse",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => callId,
  });
}

function wrapAnthropicSdkStream(
  callId: string,
  selectedModel: Model<"anthropic-messages"> = anthropicModel,
): StreamFn {
  const registry = createApiRegistry();
  registerBuiltInApiProviders(registry);
  const provider = registry.getApiProvider("anthropic-messages");
  if (!provider) {
    throw new Error("Anthropic provider not registered");
  }
  return wrapStreamFnWithDiagnosticModelCallEvents(provider.stream as StreamFn, {
    runId: `run-${callId}`,
    provider: selectedModel.provider,
    model: selectedModel.id,
    api: selectedModel.api,
    transport: "sse",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => callId,
  });
}

afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OpenAI producer to transport collector integration", () => {
  it("correlates SDK retries through the diagnostic requestId with exact totals", async () => {
    const networkFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "openai-model": model.id,
            "retry-after-ms": "0",
          },
        }),
      )
      .mockResolvedValueOnce(completedSseResponse());
    vi.stubGlobal("fetch", networkFetch);
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-sdk-retry");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 1,
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          entries: [{ callId: "call-real-sdk-retry", transport: "responses-sdk" }],
        },
        attempts: {
          total: 2,
          totalKind: "exact",
          initial: 1,
          retries: 1,
        },
        events: { total: 2, totalKind: "exact", entriesTruncated: false },
      },
    });
  });

  it("projects missing serving authority as a provider-fallback lower bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse({ includeAuthority: false })),
    );
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-sdk-missing-authority");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 0,
        }),
      );
    });

    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_totals_lower_bound"]),
      },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          entries: [{ callId: "call-real-sdk-missing-authority" }],
        },
        attempts: { total: 1, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
      },
    });
    expect(projection.snapshot?.logicalCalls.entries[0]).not.toHaveProperty("servingModel");
  });

  it("conserves Anthropic server fallback as one attempt plus one serving transition", async () => {
    const response = new Response(
      [
        {
          type: "message_start",
          message: {
            id: "msg_fallback",
            model: "claude-fable-5",
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            iterations: [
              {
                type: "fallback_message",
                model: "claude-opus-5",
                input_tokens: 2,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            ],
          },
        },
        { type: "message_stop" },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const buildAnthropicFetch = (
      _model: Model,
      _timeout: number | undefined,
      options: {
        beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        observeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        onFetchDispatch?: () => void;
      },
    ) => ({
      fetch: async () => {
        const dispatch = {
          url: "https://api.anthropic.com/v1/messages",
          init: {},
        };
        options.beforeFetchDispatch?.(dispatch);
        options.observeFetchDispatch?.(dispatch);
        options.onFetchDispatch?.();
        return await Promise.resolve(response);
      },
      provenance: "dispatch_attested" as const,
    });
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: buildAnthropicFetch,
      buildModelFetchWithBlockingDispatchGuard: buildAnthropicFetch,
      buildModelFetch: (_model, _timeout, options) => async () => {
        options?.onFetchDispatch?.();
        return await Promise.resolve(response);
      },
      resolveProviderEndpointClass: () => "anthropic-public",
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicStream("call-anthropic-fallback");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(anthropicModel, context, {
          apiKey: "test-key",
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          entries: [
            {
              callId: "call-anthropic-fallback",
              transport: "sse",
              servingModel: "claude-opus-5",
            },
          ],
        },
        attempts: { total: 1, initial: 1, retries: 0, totalKind: "exact" },
        providerFallbacks: { total: 1, server: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact", entriesTruncated: false },
      },
    });
  });

  it("blocks a real Anthropic fallback redirect before second-hop egress", async () => {
    let redirectorHits = 0;
    let blockedSinkHits = 0;
    const blockedSink = createServer((_request, response) => {
      blockedSinkHits += 1;
      response.writeHead(500);
      response.end("unreachable");
    });
    const blockedSinkPort = await listenLoopback(blockedSink);
    const redirector = createServer((_request, response) => {
      redirectorHits += 1;
      response.writeHead(307, {
        location: `http://127.0.0.1:${blockedSinkPort}/outside-anthropic`,
      });
      response.end();
    });
    const redirectorPort = await listenLoopback(redirector);
    const redirectOrigin = `http://127.0.0.1:${redirectorPort}`;
    const publicModel = {
      ...anthropicModel,
      baseUrl: "https://api.anthropic.com",
    } satisfies Model<"anthropic-messages">;
    const redirectModel = attachModelProviderRequestTransport(
      { ...publicModel, baseUrl: redirectOrigin },
      { allowPrivateNetwork: true },
    );
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithBlockingDispatchGuard: (_model, timeoutMs, options) => {
        const fetch = buildGuardedModelFetch(redirectModel, timeoutMs, options);
        return {
          fetch: async (input, init) => {
            const source = input instanceof Request ? new URL(input.url) : new URL(String(input));
            return await fetch(new URL(`${source.pathname}${source.search}`, redirectOrigin), init);
          },
          provenance: "dispatch_attested",
        };
      },
      resolveProviderEndpointClass: (url) => {
        if (!url) {
          return "";
        }
        const parsed = new URL(url);
        return parsed.hostname === "api.anthropic.com" || parsed.port === String(redirectorPort)
          ? "anthropic-public"
          : "custom";
      },
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicStream("call-anthropic-real-redirect", publicModel);
    const observedEvents: unknown[] = [];
    try {
      await runWithProviderTransportAccountingObserver(collector.observer, async () => {
        const stream = await wrapped(publicModel, context, {
          apiKey: "test-key",
          maxRetries: 0,
        });
        for await (const event of stream) {
          observedEvents.push(event);
        }
      });
    } finally {
      await Promise.all([closeServer(redirector), closeServer(blockedSink)]);
    }

    expect(JSON.stringify(observedEvents)).toContain(
      "Anthropic server fallback cannot redirect outside Anthropic public authority",
    );
    expect(redirectorHits).toBe(1);
    expect(blockedSinkHits).toBe(0);
    expect(collector.project()).toMatchObject({
      coverage: {
        state: "partial",
        reasons: ["transport_totals_lower_bound"],
      },
      snapshot: {
        attempts: {
          total: 1,
          totalKind: "exact",
          initial: 1,
          retries: 0,
        },
        providerFallbacks: {
          total: 0,
          totalKind: "lower_bound",
        },
        zeroSubmissions: {
          total: 0,
          totalKind: "exact",
        },
      },
    });
  });

  it("projects boundary-aligned compatible Anthropic EOF as a failed attempt", async () => {
    const compatibleModel = {
      ...anthropicModel,
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      baseUrl: "https://compatible.example",
    } satisfies Model<"anthropic-messages">;
    const response = new Response(
      [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_eof",
            model: anthropicModel.id,
            usage: { input_tokens: 2, output_tokens: 0 },
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
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const buildCompatibleFetch = (
      _model: Model,
      _timeout: number | undefined,
      options: {
        beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        observeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        onFetchDispatch?: () => void;
      },
    ) => ({
      fetch: async () => {
        const dispatch = { url: "https://compatible.example/v1/messages", init: {} };
        options?.beforeFetchDispatch?.(dispatch);
        options?.observeFetchDispatch?.(dispatch);
        options?.onFetchDispatch?.();
        return await Promise.resolve(response);
      },
      provenance: "dispatch_attested" as const,
    });
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: (_model, _timeout, options) =>
        buildCompatibleFetch(_model, _timeout, options).fetch,
      buildModelFetchWithDispatchAttestation: buildCompatibleFetch,
      buildModelFetchWithBlockingDispatchGuard: buildCompatibleFetch,
      resolveProviderEndpointClass: () => "custom",
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicStream("call-anthropic-compatible-eof", compatibleModel);

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(compatibleModel, context, {
          apiKey: "test-key",
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          failed: 1,
          entries: [{ callId: "call-anthropic-compatible-eof", transport: "sse" }],
        },
        attempts: { total: 1, initial: 1, retries: 0, totalKind: "exact" },
        events: { total: 1, totalKind: "exact", entriesTruncated: false },
      },
    });
  });

  it("projects injected Anthropic token refresh without inventing attempts", async () => {
    const compatibleModel = {
      ...anthropicModel,
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      baseUrl: "https://compatible.example",
    } satisfies Model<"anthropic-messages">;
    const credentials = vi.fn(async (options?: { forceRefresh?: boolean }) => ({
      token: options?.forceRefresh ? "refreshed-token" : "cached-token",
      expiresAt: null,
    }));
    const responseBody = [
      {
        type: "message_start",
        message: {
          id: "msg_injected_token_refresh",
          model: compatibleModel.id,
          usage: { input_tokens: 2, output_tokens: 0 },
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
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"type":"authentication_error","message":"expired"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const client = new Anthropic({
      apiKey: null,
      authToken: null,
      baseURL: "https://compatible.example",
      credentials,
      fetch: fetchMock,
    });
    configureAiTransportHost({
      ...initialHost,
      resolveProviderEndpointClass: () => "custom",
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicSdkStream(
      "call-anthropic-injected-token-refresh",
      compatibleModel,
    );

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(compatibleModel, context, {
          client,
          maxRetries: 1,
        } as never),
      );
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveBeenNthCalledWith(1, undefined);
    expect(credentials).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: ["transport_endpoint_authority_partial", "transport_totals_lower_bound"],
      },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          entries: [
            {
              callId: "call-anthropic-injected-token-refresh",
              transport: "sse",
            },
          ],
        },
        attempts: { total: 0, totalKind: "lower_bound" },
        events: { total: 1, totalKind: "exact", entriesTruncated: false },
      },
    });
    expect(projection.coverage).not.toMatchObject({
      reasons: expect.arrayContaining(["not_instrumented", "transport_event_conflict"]),
    });
  });

  it("keeps injected Anthropic fallback accounting lower-bound without an attested attempt", async () => {
    const responseBody = [
      {
        type: "message_start",
        message: {
          id: "msg_injected_fallback",
          model: anthropicModel.id,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "fallback",
          from: { model: "claude-fable-5" },
          to: { model: "claude-opus-5" },
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "served" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          output_tokens: 1,
          iterations: [
            { type: "message", model: "claude-fable-5" },
            { type: "fallback_message", model: "claude-opus-5" },
          ],
        },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "https://compatible.example",
      fetch: async () =>
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    configureAiTransportHost({
      ...initialHost,
      resolveProviderEndpointClass: () => "custom",
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicSdkStream("call-anthropic-injected-fallback");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(anthropicModel, context, {
          client,
        } as never),
      );
    });

    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: ["transport_endpoint_authority_partial", "transport_totals_lower_bound"],
      },
      snapshot: {
        logicalCalls: { total: 1, completed: 1 },
        attempts: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 2, totalKind: "exact", entriesTruncated: false },
      },
    });
    expect(projection.coverage).not.toMatchObject({
      reasons: expect.arrayContaining(["transport_event_conflict"]),
    });
  });

  it("keeps invalid injected Anthropic terminal fallback evidence lower-bound", async () => {
    const responseBody = [
      {
        type: "message_start",
        message: {
          id: "msg_injected_invalid_terminal_fallback",
          model: anthropicModel.id,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          output_tokens: 1,
          iterations: [
            { type: "fallback_message", model: "claude-opus-5" },
            { type: "message", model: "claude-fable-5" },
          ],
        },
      },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "https://compatible.example",
      fetch: async () =>
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    configureAiTransportHost({
      ...initialHost,
      resolveProviderEndpointClass: () => "custom",
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapAnthropicSdkStream("call-anthropic-injected-invalid-terminal-fallback");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(anthropicModel, context, {
          client,
        } as never),
      );
    });

    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: ["transport_endpoint_authority_partial", "transport_totals_lower_bound"],
      },
      snapshot: {
        logicalCalls: { total: 1, completed: 1 },
        attempts: { total: 0, totalKind: "lower_bound" },
        providerFallbacks: { total: 0, totalKind: "lower_bound" },
        events: { total: 2, totalKind: "exact", entriesTruncated: false },
      },
    });
    expect(projection.coverage).not.toMatchObject({
      reasons: expect.arrayContaining(["transport_event_conflict"]),
    });
  });

  it("conserves terminal preflight failure as exact zero submission", async () => {
    const guardedFetch = vi.fn(() => {
      throw new Error("request rejected before provider dispatch");
    });
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: () => ({
        fetch: guardedFetch,
        provenance: "dispatch_attested" as const,
      }),
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-sdk-preflight");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 0,
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          failed: 1,
          entries: [{ callId: "call-real-sdk-preflight", transport: "responses-sdk" }],
        },
        attempts: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
        events: { total: 1, totalKind: "exact" },
      },
    });
    expect(guardedFetch).toHaveBeenCalledOnce();
  });

  it("keeps host setup failure unavailable without dispatch provenance", async () => {
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: undefined,
      buildModelFetch: () => {
        throw new Error("client fetch setup failed");
      },
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-sdk-constructor");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 0,
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "unavailable" },
      snapshot: {
        logicalCalls: { total: 1, failed: 1 },
        attempts: { total: 0, totalKind: "lower_bound" },
        zeroSubmissions: { total: 0, failed: 0, totalKind: "lower_bound" },
        events: { total: 0, totalKind: "lower_bound" },
      },
    });
  });

  it("conserves payload-recovery preflight failure after an earlier submission", async () => {
    let fetchCalls = 0;
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: (_model, _timeoutMs, options) => {
        const fetchImpl = () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            options?.onFetchDispatch?.();
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    message: "invalid encrypted content",
                    type: "invalid_request_error",
                    code: "invalid_encrypted_content",
                  },
                }),
                {
                  status: 400,
                  headers: {
                    "content-type": "application/json",
                    "openai-model": model.id,
                  },
                },
              ),
            );
          }
          throw new TypeError("payload recovery rejected before provider dispatch");
        };
        return { fetch: fetchImpl, provenance: "dispatch_attested" as const };
      },
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-payload-preflight");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 0,
          onPayload: (payload: unknown) => {
            const request = payload as Record<string, unknown>;
            return {
              ...request,
              input: [
                ...((request.input as unknown[]) ?? []),
                { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
              ],
            };
          },
        }),
      );
    });

    expect(fetchCalls).toBe(2);
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { total: 1, failed: 1 },
        attempts: { total: 1, initial: 1, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("conserves a retry preflight failure after a failed same-route submission", async () => {
    let fetchCalls = 0;
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: (_model, _timeoutMs, options) => {
        const fetchImpl = () => {
          fetchCalls += 1;
          if (fetchCalls === 1) {
            options?.onFetchDispatch?.();
            return Promise.resolve(
              new Response(JSON.stringify({ error: { message: "overloaded" } }), {
                status: 503,
                headers: {
                  "content-type": "application/json",
                  "openai-model": model.id,
                  "retry-after-ms": "0",
                },
              }),
            );
          }
          throw new TypeError("retry rejected before provider dispatch");
        };
        return { fetch: fetchImpl, provenance: "dispatch_attested" as const };
      },
    });
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-retry-preflight");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 1,
        }),
      );
    });

    expect(fetchCalls).toBe(2);
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { total: 1, failed: 1 },
        attempts: { total: 1, initial: 1, retries: 0, totalKind: "exact" },
        zeroSubmissions: { total: 1, failed: 1, totalKind: "exact" },
        events: { total: 2, totalKind: "exact" },
      },
    });
  });

  it("preserves exact aggregate totals when producer detail exceeds 128 events", async () => {
    let fetchCalls = 0;
    const networkFetch = vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls <= 128) {
        return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "openai-model": model.id,
            "retry-after-ms": "0",
          },
        });
      }
      return completedSseResponse();
    });
    vi.stubGlobal("fetch", networkFetch);
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapOpenAIStream("call-real-sdk-cap");

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(model, context, {
          apiKey: "test-key",
          maxRetries: 128,
        }),
      );
    });

    const projection = collector.project();
    expect(projection).toMatchObject({
      coverage: {
        state: "partial",
        reasons: expect.arrayContaining(["transport_details_truncated"]),
      },
      snapshot: {
        logicalCalls: { total: 1, completed: 1 },
        attempts: {
          total: 129,
          totalKind: "exact",
          initial: 1,
          retries: 128,
        },
        events: { total: 129, totalKind: "exact", entriesTruncated: true },
      },
    });
    expect(projection.snapshot?.events.entries).toHaveLength(128);
    expect(networkFetch).toHaveBeenCalledTimes(129);
  });

  it("accepts cached WebSocket send fallback without inventing a connection", async () => {
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const provider = registry.getApiProvider("openai-chatgpt-responses");
    if (!provider) {
      throw new Error("expected built-in ChatGPT Responses provider");
    }
    let submissions = 0;
    class CachedSendRejectingWebSocket extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(): void {
        submissions += 1;
        if (submissions === 2) {
          throw new Error("cached socket send failed");
        }
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_cached_first",
                  status: "completed",
                  headers: { "openai-model": chatGptModel.id },
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
        });
      }
      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", CachedSendRejectingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const collector = createProviderTransportAccountingCollector();
    const wrapChatGpt = (callId: string) =>
      wrapStreamFnWithDiagnosticModelCallEvents(provider.stream as StreamFn, {
        runId: `run-${callId}`,
        provider: chatGptModel.provider,
        model: chatGptModel.id,
        api: chatGptModel.api,
        transport: "native-codex-websocket",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => callId,
      });
    const options = {
      apiKey: createJwt(),
      sessionId: "cached-accounting",
      transport: "auto" as const,
    };

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(await wrapChatGpt("call-cached-first")(chatGptModel, context, options));
      await drain(
        await wrapChatGpt("call-cached-fallback")(
          chatGptModel,
          {
            ...context,
            messages: [...context.messages, { role: "user", content: "again", timestamp: 2 }],
          },
          options,
        ),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { total: 2, completed: 2 },
        connections: { total: 1, initial: 1, totalKind: "exact" },
        attempts: { total: 2, initial: 1, transportFallbacks: 1, totalKind: "exact" },
        fallbacks: { total: 1, submissionFailures: 1, totalKind: "exact" },
      },
    });
  });

  it("consumes unsupported WebSocket fallback when SSE fails before submission", async () => {
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const provider = registry.getApiProvider("openai-chatgpt-responses");
    if (!provider) {
      throw new Error("expected built-in ChatGPT Responses provider");
    }
    vi.stubGlobal("WebSocket", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fallback fetch invocation failed");
      }),
    );
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(provider.stream as StreamFn, {
      runId: "run-unsupported-zero",
      provider: chatGptModel.provider,
      model: chatGptModel.id,
      api: chatGptModel.api,
      transport: "native-codex-websocket",
      trace: createDiagnosticTraceContext(),
      nextCallId: () => "call-unsupported-zero",
    });

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(
        await wrapped(chatGptModel, context, {
          apiKey: createJwt(),
          transport: "auto",
          maxRetries: 2,
        }),
      );
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: { total: 1, failed: 1 },
        connections: { total: 0, totalKind: "exact" },
        attempts: { total: 0, totalKind: "exact" },
        fallbacks: { total: 1, unsupported: 1, totalKind: "exact" },
        zeroSubmissions: { total: 3, failed: 3, totalKind: "exact" },
      },
    });
  });
});
