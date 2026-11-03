import type { Model, ProviderCallStreamOptions } from "openclaw/plugin-sdk/llm";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { buildGoogleProvider } from "./provider-registration.js";
import type { GoogleContinuationOptions } from "./transport-stream-types.js";

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: () => guardedFetch,
}));

const token = "synthetic-owned-google-continuation";
const continued = {
  candidates: [
    {
      finishReason: "CONTINUATION",
      continuationToken: token,
      content: { parts: [{ text: "first" }] },
    },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
};
const stopped = {
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: "second" }] } }],
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const response = (wire = frame(continued)) =>
  new Response(wire, { headers: { "content-type": "text/event-stream" } });
const model = makeProviderModel("google-generative-ai", "clawrouter", "gemini-3.5-flash", {
  baseUrl: "https://router.example/v1/native/google-gemini/v1beta",
});
const context = {
  messages: [{ role: "user" as const, content: "Synthetic original request", timestamp: 0 }],
};
type Options = ProviderCallStreamOptions & GoogleContinuationOptions;
const options: Options = {
  apiKey: "synthetic-proxy-key",
  headers: { Authorization: "Bearer synthetic-proxy-key" },
  sessionId: "synthetic-session",
  authProfileId: "synthetic-profile",
  maxTokens: 100,
};

async function start(
  overrides: Options = {},
  selected: Model = model,
  messages = context.messages,
) {
  const streamFn = buildGoogleProvider().createStreamFn?.({
    provider: selected.provider,
    modelId: selected.id,
    model: selected,
  });
  assert(streamFn);
  return streamFn(selected, { messages }, { ...options, ...overrides });
}
async function initial() {
  guardedFetch.mockResolvedValueOnce(response());
  const result = await (await start()).result();
  assert(result.providerReplay, result.errorMessage);
  return result.providerReplay;
}
afterEach(() => {
  guardedFetch.mockReset();
  vi.unstubAllEnvs();
});

describe("actual routed Google continuation transport", () => {
  it("keeps each hop explicit and replays the original request with the proxy credential", async () => {
    vi.stubEnv("GEMINI_API_KEYS", "synthetic-unused-vendor-key");
    const receipt = await initial();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(receipt.id).toBe(token);
    const original = JSON.parse(guardedFetch.mock.calls[0][1].body);
    guardedFetch.mockResolvedValueOnce(response(frame(stopped)));
    const result = await (
      await start({
        googleContinuation: receipt,
        headers: { ...options.headers, "X-Request-ID": "second-hop" },
      })
    ).result();
    expect(result.stopReason).toBe("stop");
    expect(result.providerReplay).toBeUndefined();
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    const [url, request] = guardedFetch.mock.calls[1];
    expect(url).toBe(
      "https://router.example/v1/native/google-gemini/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
    );
    expect(JSON.parse(request.body)).toEqual({ ...original, continuationToken: token });
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer synthetic-proxy-key");
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("synthetic-proxy-key");
  });

  it.each([
    { name: "credential", options: { apiKey: "synthetic-other-key" } },
    {
      name: "principal header",
      options: { headers: { Authorization: "Bearer synthetic-other-principal" } },
    },
    { name: "profile", options: { authProfileId: "other-profile" } },
    { name: "session", options: { sessionId: "other-session" } },
    { name: "generation settings", options: { maxTokens: 99 } },
    { name: "model", model: { ...model, id: "gemini-embedding-001" } },
    {
      name: "origin",
      model: { ...model, baseUrl: "https://other.example/v1/native/google-gemini/v1beta" },
    },
    { name: "input", messages: [{ ...context.messages[0], content: "Changed request" }] },
  ])("rejects changed $name before another dispatch", async (change) => {
    const receipt = await initial();
    const result = await (
      await start({ googleContinuation: receipt, ...change.options }, change.model, change.messages)
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("original request and caller credential");
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("withholds replay evidence until real HTTP EOF, including after a DONE marker", async () => {
    const waiting = Promise.withResolvers<void>();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sent = false;
    guardedFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              body = controller;
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode(frame(continued) + "data: [DONE]\n\n"));
              } else {
                waiting.resolve();
              }
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const stream = await start();
    const result = stream.result();
    const phase = await Promise.race([
      waiting.promise.then(() => "awaiting HTTP EOF"),
      result.then(() => "ended early"),
    ]);
    if (phase === "awaiting HTTP EOF") body?.close();
    expect(phase).toBe("awaiting HTTP EOF");
    expect((await result).providerReplay?.id).toBe(token);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["partial frame", frame(continued) + "data: {"],
    ["error event", "event: error\n" + frame(continued)],
    [
      "late error",
      frame(continued) + frame({ error: { code: 503, message: "Synthetic unavailable" } }),
    ],
    [
      "error after DONE",
      frame(continued) +
        "data: [DONE]\n\n" +
        frame({ error: { code: 503, message: "Synthetic unavailable" } }),
    ],
    ["oversized frame", frame(continued) + frame({ padding: "x".repeat(2 * 1024 * 1024) })],
  ])("keeps %s uncertain without a replay or fallback", async (_, wire) => {
    guardedFetch.mockResolvedValueOnce(response(wire));
    const result = await (await start()).result();
    expect(result.stopReason).toBe("error");
    expect(result.providerReplay).toBeUndefined();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not publish a token from a canceled response", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    guardedFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(new TextEncoder().encode(frame(continued)));
          },
          cancel,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const stream = await start({ signal: controller.signal });
    for await (const event of stream) {
      if (event.type === "text_delta") controller.abort();
    }
    expect((await stream.result()).providerReplay).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["continuationToken", "continuation_token"])(
    "rejects raw %s payload injection",
    async (key) => {
      const result = await (
        await start({ onPayload: (payload) => ({ ...(payload as object), [key]: token }) })
      ).result();
      expect(result.errorMessage).toContain("completed response receipt");
      expect(guardedFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "x".repeat(16 * 1024 + 1)])(
    "does not retain an invalid continuation token",
    async (invalidToken) => {
      guardedFetch.mockResolvedValueOnce(
        response(
          frame({
            candidates: [{ finishReason: "CONTINUATION", continuationToken: invalidToken }],
          }),
        ),
      );
      expect((await (await start()).result()).providerReplay).toBeUndefined();
    },
  );

  it("preserves direct Google terminal-marker behavior without a routed replay receipt", async () => {
    guardedFetch.mockResolvedValueOnce(response(frame(continued) + "data: [DONE]\n\n" + "data: {"));
    const result = await (
      await start(
        {},
        {
          ...model,
          provider: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        },
      )
    ).result();
    expect(result.stopReason).toBe("length");
    expect(result.providerReplay).toBeUndefined();
  });
});
