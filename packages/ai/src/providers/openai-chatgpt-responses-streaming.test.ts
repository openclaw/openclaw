import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import { streamOpenAICodexResponses } from "./openai-chatgpt-responses.js";
import {
  chatgptContext as context,
  createJwt,
  resetChatgptTransport,
  sseResponse,
} from "./openai-chatgpt-responses.test-helpers.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";

const apiKey = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
const sseOptions = { apiKey, transport: "sse" as const };

function installSse(payload: object) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(sseResponse(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function responseEvent(type: string, id: string, fields: object) {
  return { type: `response.${type}`, response: { id, ...fields } };
}

function message(id: string, text: string) {
  return { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] };
}

function refusal(category: string, review?: object) {
  return {
    type: "provider_refusal",
    details: { provider: "openai", category, ...(review ? { review } : {}) },
  };
}

function transportMetadata(stopReason: "error" | "aborted", transport: string) {
  return {
    api: "openai-chatgpt-responses",
    model: "gpt-5.6-luna",
    provider: "openai",
    elapsedMs: expect.any(Number),
    stopReason,
    transport,
    failureKind: stopReason === "aborted" ? "caller-abort" : "provider-failure",
  };
}

function transportWarning(logWarn: ReturnType<typeof vi.fn>) {
  const warnings = logWarn.mock.calls.filter(([category]) => category === "openai-transport");
  expect(warnings).toHaveLength(1);
  return warnings[0]?.[2];
}

function installWebSocket(payload: object, onSend?: () => void) {
  class FixtureWebSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(): void {
      if (onSend) {
        onSend();
        return;
      }
      queueMicrotask(() =>
        this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(payload) })),
      );
    }
    close(): void {}
  }
  const fetchMock = vi.fn();
  vi.stubGlobal("WebSocket", FixtureWebSocket);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function collectEvents(stream: ReturnType<typeof streamOpenAICodexResponses>) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("OpenAI ChatGPT Responses inference streaming", () => {
  afterEach(resetChatgptTransport);

  const model = makeOpenAIProviderModel("openai-chatgpt-responses", {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    baseUrl: "https://chatgpt.test/backend-api",
    maxTokens: 16_000,
  });

  it("preserves incomplete SSE terminals without exposing truncated tool calls", async () => {
    const payload = responseEvent("incomplete", "resp_incomplete", {
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        message("msg_partial", "TERMINAL_PARTIAL"),
        {
          type: "function_call",
          id: "fc_truncated",
          call_id: "call_truncated",
          name: "write",
          arguments: '{"path":"unfinished',
        },
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 4,
        total_tokens: 25,
        input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
      },
    });
    installSse(payload);

    const result = await streamOpenAICodexResponses(model, context, sseOptions).result();

    expect(result).toMatchObject({
      stopReason: "length",
      responseId: "resp_incomplete",
      content: [{ type: "text", text: "TERMINAL_PARTIAL" }],
      usage: { input: 13, output: 4, cacheRead: 6, cacheWrite: 2, totalTokens: 25 },
    });
    expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  });

  it.each(["sse", "websocket"] as const)(
    "emits an error for content-filtered incomplete %s turns without a status",
    async (transport) => {
      const id = transport === "sse" ? "resp_filtered" : "resp_ws_filtered";
      const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };
      const payload = responseEvent("incomplete", id, {
        incomplete_details: { reason: "content_filter" },
        output: transport === "sse" ? [message("msg_filtered", "FILTERED_PARTIAL")] : [],
        usage,
      });
      const fetchMock = transport === "sse" ? installSse(payload) : installWebSocket(payload);
      const events = await collectEvents(
        streamOpenAICodexResponses(model, context, { apiKey, transport }),
      );
      expect(events.map((event) => event.type)).toEqual(["start", "error"]);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        reason: "error",
        error: {
          stopReason: "error",
          responseId: id,
          errorMessage: "Provider incomplete_reason: content_filter",
          ...(transport === "sse"
            ? { content: [], usage: { input: 12, output: 3, totalTokens: 15 } }
            : {}),
        },
      });
      if (transport === "websocket") {
        expect(fetchMock).not.toHaveBeenCalled();
      }
    },
  );

  it("projects a structured ChatGPT cyber-policy error as a provider refusal", async () => {
    installSse({
      type: "error",
      message: "This request was blocked by the provider's cyber policy.",
      codexErrorInfo: "cyberPolicy",
    });

    const stream = streamOpenAICodexResponses(model, context, sseOptions);
    const events = await collectEvents(stream);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        stopReason: "error",
        diagnostics: [refusal("cyber")],
      },
    });
  });

  it("keeps the raw misalignment terminal error without retrying", async () => {
    const code = "misalignment_policy_violation";

    const error = {
      code,
      type: "invalid_request_error",
      message: "This synthetic request was refused by provider policy.",
      misalignment: {
        error_type: "future_category",
        detailed_explanation: "The proposed action differed from the requested task.",
        steer: { message: "  Continue only the requested task.\n" },
      },
    };
    const payload = { type: "error", error };
    const fetchMock = installSse(payload);

    const stream = streamOpenAICodexResponses(model, context, sseOptions);
    const events = await collectEvents(stream);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "error" || event.type === "done")).toMatchObject(
      [
        {
          type: "error",
          reason: "error",
          error: {
            stopReason: "error",
            errorCode: code,
            diagnostics: [
              refusal("misalignment", {
                explanation: error.misalignment.detailed_explanation,
                continuation: error.misalignment.steer,
                errorType: error.misalignment.error_type,
              }),
            ],
          },
        },
      ],
    );
  });

  it("reports acceptance before the default WebSocket stream starts", async () => {
    const fetchMock = installWebSocket(
      responseEvent("completed", "resp_ws_accepted", {
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }),
    );

    const order: string[] = [];
    const acceptanceObserver = vi.fn(() => {
      order.push("accepted");
    });
    const options = withProviderAcceptanceObserver({ apiKey }, acceptanceObserver);

    const stream = streamOpenAICodexResponses(model, context, options);
    for await (const event of stream) {
      order.push(event.type);
    }

    expect(order).toEqual(["accepted", "start", "done"]);
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs the caller abort reason with bounded ChatGPT transport metadata", async () => {
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const controller = new AbortController();
    const fetchMock = installWebSocket({}, () => {
      controller.abort(new Error("Compaction timed out"));
    });

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey,
      signal: controller.signal,
    }).result();

    expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    expect(logWarn).toHaveBeenCalledWith(
      "openai-transport",
      "ChatGPT Responses stream terminated",
      transportMetadata("aborted", "auto"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs HTTP rejection details separately from transport failure metadata", async () => {
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "hostile prompt echo in a 400 body",
            code: "invalid_request",
            type: "invalid_request_error",
          },
        }),
        { status: 400, statusText: "Bad Request" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, sseOptions).result();

    expect(result).toMatchObject({ stopReason: "error", errorType: "invalid_request_error" });
    expect(logWarn).toHaveBeenCalledWith(
      "provider-error",
      "Model request failed",
      expect.objectContaining({
        status: 400,
        code: "invalid_request",
        type: "invalid_request_error",
      }),
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain("hostile prompt echo in a 400 body");
    const logged = transportWarning(logWarn);
    expect(logged).toMatchObject({ stopReason: "error", failureKind: "provider-failure" });
    const serialized = JSON.stringify(logged);
    for (const hostile of ["hostile", "invalid_request", "400 body"]) {
      expect(serialized).not.toContain(hostile);
    }
  });

  it("preserves failed response identity and misalignment details over WebSocket", async () => {
    const transport = "websocket";
    const code = "misalignment_policy_violation";

    const failedResponse = {
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        error: {
          code,
          type: "hostile type: user prompt echoed here",
          message: "rejected",
          misalignment: {
            detailed_explanation: "The proposed action differs from the requested task.",
            steer: { message: "Continue only the requested task." },
          },
        },
      },
    };
    const logWarn = vi.fn();
    configureAiTransportHost({ logWarn });
    const fetchMock = installWebSocket(failedResponse);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey,
      transport,
    });
    const events = await collectEvents(stream);

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        responseId: "resp_failed",
        stopReason: "error",
        errorMessage: `${code}: rejected`,
      },
    });
    const result = await stream.result();
    expect(result.diagnostics).toMatchObject([
      refusal("misalignment", {
        explanation: failedResponse.response.error.misalignment.detailed_explanation,
        continuation: failedResponse.response.error.misalignment.steer,
      }),
    ]);
    expect(logWarn).toHaveBeenCalledWith(
      "provider-error",
      "Model request failed",
      expect.objectContaining({ responseId: "resp_failed" }),
    );
    const logged = transportWarning(logWarn);
    expect(logged).toEqual(transportMetadata("error", transport));
    const serialized = JSON.stringify(logged);
    for (const hostile of ["rejected", "invalid_prompt", "hostile type", "echoed"]) {
      expect(serialized).not.toContain(hostile);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
