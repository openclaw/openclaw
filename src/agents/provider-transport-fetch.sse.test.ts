import { onLlmRequestActivity } from "@openclaw/ai/internal/runtime";
import { Stream } from "openai/streaming";
import { describe, expect, it, vi } from "vitest";
import {
  buildGuardedModelFetch,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

describe("buildGuardedModelFetch SSE readability", () => {
  installProviderTransportFetchTestHooks();

  it("drops event-only SSE frames before the OpenAI SDK stream parser sees them", async () => {
    const encoder = new TextEncoder();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: message\n\n"));
            controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const response = await buildGuardedModelFetch(model)("https://openrouter.ai/api/v1/responses", {
      method: "POST",
    });
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it("reports filtered keepalive frames as request activity", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(': keepalive\n\nevent: message\n\ndata: {"ok": true}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://openrouter.ai/api/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);

    try {
      const response = await buildGuardedModelFetch(model)(
        "https://openrouter.ai/api/v1/responses",
        { method: "POST", signal: controller.signal },
      );
      const items = [];
      for await (const item of Stream.fromSSEResponse(response, controller)) {
        items.push(item);
      }

      expect(items).toEqual([{ ok: true }]);
      expect(onActivity).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("leaves official OpenAI SSE streams unmodified", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: response.created\n\ndata: {"ok": true}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
    const model = makeProviderModelFixture<"openai-responses">({
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    const body = JSON.stringify({ model: "gpt-5.5", stream: true });
    const parse = vi.spyOn(JSON, "parse");

    const response = await buildGuardedModelFetch(model)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    await expect(response.text()).resolves.toBe(
      'event: response.created\n\ndata: {"ok": true}\n\n',
    );
  });

  it("drops whitespace-only SSE data frames with CRLF delimiters", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('event: message\r\ndata:   \r\n\r\ndata: {"ok": true}\r\n\r\n', {
        headers: { "content-type": "text/event-stream" },
      }),
      finalUrl: "https://api.openai.com/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );
    const items = [];
    for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
      items.push(item);
    }

    expect(items).toEqual([{ ok: true }]);
  });

  it.each([
    {
      name: "bare, empty, and Unicode whitespace data",
      body: "data\n\ndata:\n\ndata: \t\uFEFF\u00A0\n\n",
      expectedBody: "",
    },
    {
      name: "case-sensitive fields at the start of a line",
      body: 'Data: ignored\n data: ignored\ndatabase: ignored\n\ndata: {"ok": true}\n\n',
      expectedBody: 'data: {"ok": true}\n\n',
    },
    {
      name: "multiline data including blank lines",
      body: 'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r\n\r\n',
      expectedBody: 'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r\n\r\n',
    },
    {
      name: "characters outside JavaScript trim whitespace",
      body: "data: \u0085\r\rdata: \u200B\r\r",
      expectedBody: "data: \u0085\r\rdata: \u200B\r\r",
    },
    {
      name: "readable EOF tail with a final blank data line",
      body: 'data: {"ok": true}\ndata: \t',
      expectedBody: 'data: {"ok": true}\ndata: \t',
    },
    {
      name: "split CRLF delimiters",
      body: "",
      chunks: ['data: {"ok": true}\r', "\n\r", "\n"],
      expectedBody: 'data: {"ok": true}\r\n\r\n',
    },
    {
      name: "split CR-only delimiters after a keepalive",
      body: "",
      chunks: ["event: ping\r", '\rdata: {"ok": true}\r', "\r"],
      expectedBody: 'data: {"ok": true}\r\r',
    },
    {
      name: "split LF delimiter after a partial payload",
      body: "",
      chunks: ['data: {"ok"', ": true}\n", "\n"],
      expectedBody: 'data: {"ok": true}\n\n',
    },
    {
      name: "blank EOF tail",
      body: "event: ping\ndata\ndata: \t\uFEFF\u00A0",
      expectedBody: "",
    },
  ])("preserves SSE readability for $name", async ({ body, chunks, expectedBody }) => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks ?? [body]) {
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      finalUrl: "https://openrouter.ai/api/v1/chat/completions",
      release: vi.fn(async () => undefined),
    });
    const model = makeProviderModelFixture<"openai-completions">({
      id: "gpt-5.4",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const response = await buildGuardedModelFetch(model)(
      "https://openrouter.ai/api/v1/chat/completions",
      { method: "POST" },
    );

    await expect(response.text()).resolves.toBe(expectedBody);
  });
});
