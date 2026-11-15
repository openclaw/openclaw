// Prepare worker-backed SDK fixtures before the timed first-stream lifecycle cases.
import "openclaw/plugin-sdk/provider-transport-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProviderModel } from "../../packages/ai/src/providers/provider-model.test-support.js";
import { buildGoogleProvider } from "./provider-registration.js";

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  buildGuardedModelFetch: () => guardedFetch,
}));

const terminal = {
  candidates: [{ content: { parts: [{ text: "complete" }] }, finishReason: "STOP" }],
};
const completedResponse = { stopReason: "stop", content: [{ type: "text", text: "complete" }] };
const quotaError = {
  error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Request denied" },
};
const encodeEvent = (event: unknown) =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
function response(events: readonly unknown[], cancel = vi.fn(), open = false) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(encodeEvent).join("")));
      if (!open) {
        controller.close();
      }
    },
    cancel,
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
async function startStream(signal: AbortSignal, id = "gemini-2.5-pro", hook?: () => Promise<void>) {
  const model = makeProviderModel("google-generative-ai", "google", id, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });
  const streamFn = buildGoogleProvider().createStreamFn?.({
    provider: model.provider,
    modelId: model.id,
    model,
  });
  assert(streamFn, "Google registration must provide its stream");
  const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 0 }] };
  return streamFn(model, context, { apiKey: "fixture-key-1", signal, onPayload: hook });
}
async function advanceResponse(ms: number, id: string, expected: object = completedResponse) {
  const controller = new AbortController();
  const completed = vi.fn();
  const pending = (await startStream(controller.signal, id)).result().then(completed);
  await vi.advanceTimersByTimeAsync(ms);
  const result = completed.mock.calls[0]?.[0];
  controller.abort();
  await pending;
  expect(result).toMatchObject(expected);
}

describe("Google stream lifecycle", () => {
  beforeEach(() => {
    guardedFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each<[string, readonly unknown[], object]>([
    [
      "terminal marker",
      [
        { responseId: "fixture-response", usageMetadata: { promptTokenCount: 10 } },
        terminal,
        "[DONE]",
        quotaError,
      ],
      { ...completedResponse, responseId: "fixture-response", usage: { input: 10 } },
    ],
    [
      "blocked prompt",
      [{ promptFeedback: { blockReason: "SAFETY" } }],
      { stopReason: "error", errorCode: "SAFETY" },
    ],
  ])("releases the open body after %s", async (_name, events, expected) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    guardedFetch.mockResolvedValueOnce(response(events, cancel, true));
    await advanceResponse(1, "gemini-3.1-pro-preview", expected);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts before dispatch while the payload hook is pending", async () => {
    const controller = new AbortController();
    const stream = await startStream(controller.signal, undefined, () => {
      queueMicrotask(() => controller.abort());
      return Promise.withResolvers<undefined>().promise;
    });
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "aborted" });
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("rotates keys on the first provider frame's quota status", async () => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "fixture-key-2");
    guardedFetch
      .mockResolvedValueOnce(response([quotaError]))
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    const stream = await startStream(new AbortController().signal);
    expect(await stream.result()).toMatchObject(completedResponse);
    expect(
      guardedFetch.mock.calls.map(([, init]) => new Headers(init.headers).get("x-goog-api-key")),
    ).toEqual(["fixture-key-1", "fixture-key-2"]);
    expect(guardedFetch.mock.calls[1]?.[1].body).toBe(guardedFetch.mock.calls[0]?.[1].body);
  });

  it("keeps the deadline while only metadata and empty content arrive", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    const cancel = vi.fn();
    const emptyFrames = [
      { usageMetadata: { promptTokenCount: 10 } },
      { candidates: [{ finishReason: "" }] },
      { candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }] },
      { candidates: [{ content: { parts: [{ text: "" }] } }] },
    ];
    guardedFetch
      .mockResolvedValueOnce(response(emptyFrames, cancel, true))
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    await advanceResponse(11, "gemini-3.1-pro-preview");
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      JSON.parse(guardedFetch.mock.calls[1]?.[1].body).generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: "LOW" });
  });
});
