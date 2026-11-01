import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "./provider-registration.js";

const model: Model = {
  id: "gemini-2.5-flash",
  name: "Gemini Flash",
  api: "google-interactions",
  provider: "google",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };

function success() {
  return new Response(
    'data: {"event_type":"step.delta","delta":{"type":"text","text":"recovered"}}\n\ndata: {"event_type":"interaction.completed"}\n\n',
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
function select(requestModel: Model) {
  return buildGoogleProvider().createStreamFn?.({
    provider: requestModel.provider,
    modelId: requestModel.id,
    model: requestModel,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google Interactions provider parity", () => {
  it.each([
    { proxy: { mode: "explicit-proxy", url: "http://8.8.8.8:8080" } },
    { tls: { insecureSkipVerify: false } },
  ])("dispatches Interactions through managed request settings %j", async (request) => {
    const requestModel = {
      ...model,
      [Symbol.for("openclaw.modelProviderRequestTransport")]: request,
    };
    const streamFn = select(requestModel);
    assert(streamFn, "Google must own managed Interactions requests");
    const fetch = vi.fn().mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const result = await (
      await streamFn(requestModel, context, { apiKey: "gemini-key-1" })
    ).result();
    expect(result.errorMessage).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain("/interactions?alt=sse");
    expect(fetch.mock.calls[0]?.[1]).toHaveProperty("redirect", "manual");
  });

  it("sends OAuth JSON credentials as a bearer token, not an API key", async () => {
    const fetch = vi.fn().mockResolvedValue(success());
    vi.stubGlobal("fetch", fetch);
    const streamFn = select(model);
    assert(streamFn);
    const result = await (
      await streamFn(model, context, {
        apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }),
      })
    ).result();
    expect(result.stopReason).toBe("stop");
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer oauth-token");
    expect(headers.has("x-goog-api-key")).toBe(false);
  });

  it.each([
    ["none", "none"],
    ["required", "any"],
    [
      { type: "function", function: { name: "lookup" } },
      { allowed_tools: { mode: "any", tools: ["lookup"] } },
    ],
  ] as const)("forwards tool choice %j as %j", async (toolChoice, expected) => {
    const fetch = vi.fn().mockResolvedValue(success());
    vi.stubGlobal("fetch", fetch);
    const streamFn = select(model);
    assert(streamFn);
    const toolContext = {
      ...context,
      tools: [{ name: "lookup", description: "Look up", parameters: { type: "object" } }],
    };
    // Agent call options carry Google's toolChoice beyond the shared simple options.
    const callOptions = { apiKey: "gemini-key-1", toolChoice };
    await (await streamFn(model, toolContext, callOptions)).result();
    const body: unknown = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body).toMatchObject({ generation_config: { tool_choice: expected } });
  });

  it("rotates a pre-stream HTTP 429 to the next Gemini key", async () => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "gemini-key-2");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"rate limited"}}', { status: 429 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const streamFn = select(model);
    assert(streamFn);
    const stream = await streamFn(model, context, { apiKey: "gemini-key-1" });
    const result = await stream.result();
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("x-goog-api-key")),
    ).toEqual(["gemini-key-1", "gemini-key-2"]);
  });

  it.each([
    {
      name: "OAuth credentials",
      apiKey: JSON.stringify({ token: "oauth-token", projectId: "demo" }),
    },
    { name: "model auth headers", model: { headers: { Authorization: "Bearer explicit-token" } } },
    { name: "option auth headers", headers: { "X-Goog-Api-Key": "explicit-key" } },
    { name: "custom endpoints", model: { baseUrl: "https://proxy.example.com/v1beta" } },
    {
      name: "non-TLS endpoints",
      model: { baseUrl: "http://generativelanguage.googleapis.com/v1beta" },
    },
  ])("does not rotate Gemini keys for $name", async (testCase) => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "gemini-key-2");
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"rate limited"}}', { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    const requestModel = { ...model, ...testCase.model };
    const streamFn = select(requestModel);
    assert(streamFn);
    const result = await (
      await streamFn(requestModel, context, {
        apiKey: testCase.apiKey ?? "gemini-key-1",
        headers: testCase.headers,
      })
    ).result();
    expect(result.stopReason).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never rotates a key after the stream has started", async () => {
    vi.stubEnv("GEMINI_API_KEYS", "gemini-key-2");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          'data: {"event_type":"step.delta","delta":{"type":"text","text":"partial"}}\n\ndata: {"event_type":"error","error":{"message":"HTTP 429 rate limited"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const streamFn = select(model);
    assert(streamFn);
    const stream = await streamFn(model, context, { apiKey: "gemini-key-1" });
    const events = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    expect(events).toEqual(["start", "text_start", "text_delta", "error"]);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "partial" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
