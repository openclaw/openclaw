import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaStreamFn } from "./stream.js";

// Minimal streaming response that completes cleanly.
const NDJSON_OK = [
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":"hi"},"done":false}',
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
].join("\n");

async function drainStream(
  streamOrPromise: ReturnType<ReturnType<typeof createOllamaStreamFn>>,
): Promise<void> {
  // StreamFn may return AssistantMessageEventStream directly or wrap it in a
  // Promise — resolve either case before iterating.
  const stream = await Promise.resolve(streamOrPromise);
  for await (const _ of stream) {
    // consume
  }
}

describe("createOllamaStreamFn — per-model baseUrl resolution (#61678)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the creation-time baseUrl when the model carries no baseUrl", async () => {
    const fetchMock = vi.fn(async () => new Response(`${NDJSON_OK}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const streamFn = createOllamaStreamFn("http://127.0.0.1:11434");
    await drainStream(
      streamFn(
        { id: "llama3:8b", api: "ollama", provider: "ollama", contextWindow: 8192 } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {} as never,
      ),
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("prefers the model's own baseUrl over the creation-time default", async () => {
    // Simulates the "ollama2" scenario: the globally-registered "ollama" API
    // stream function was created for the first provider (port 11434), but a
    // different provider ("ollama2") configured on port 11435 has its own
    // baseUrl baked into its model object.  The stream function must route to
    // port 11435, not the default 11434.
    const fetchMock = vi.fn(async () => new Response(`${NDJSON_OK}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const streamFn = createOllamaStreamFn("http://127.0.0.1:11434");
    await drainStream(
      streamFn(
        {
          id: "gemma4:e2b",
          api: "ollama",
          provider: "ollama2",
          contextWindow: 16384,
          baseUrl: "http://127.0.0.1:11435",
        } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {} as never,
      ),
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11435/api/chat");
  });

  it("normalizes /v1 in the model's own baseUrl", async () => {
    const fetchMock = vi.fn(async () => new Response(`${NDJSON_OK}\n`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const streamFn = createOllamaStreamFn("http://127.0.0.1:11434");
    await drainStream(
      streamFn(
        {
          id: "qwen3:8b",
          api: "ollama",
          provider: "ollama2",
          contextWindow: 32768,
          baseUrl: "http://127.0.0.1:11435/v1",
        } as never,
        { messages: [{ role: "user", content: "hi" }] } as never,
        {} as never,
      ),
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11435/api/chat");
  });
});
