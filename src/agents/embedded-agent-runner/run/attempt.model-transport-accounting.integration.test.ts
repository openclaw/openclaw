import {
  configureAiTransportHost,
  createApiRegistry,
  getAiTransportHost,
  type Context,
  type Model,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../llm/ai-transport-host.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  createProviderTransportAccountingCollector,
  runWithProviderTransportAccountingObserver,
} from "../../provider-transport-accounting.js";
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
