import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleGenerativeAiTransportStreamFn } from "./transport-stream.js";

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
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map(encodeEvent).join("")));
        if (!open) {
          controller.close();
        }
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function run(signal: AbortSignal, id = "gemini-2.5-pro") {
  const model: Model<"google-generative-ai"> = {
    id,
    name: id,
    provider: "google",
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const stream = await createGoogleGenerativeAiTransportStreamFn()(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { apiKey: "fixture-key-1", signal },
  );
  return stream.result();
}
async function advanceResponse(ms: number, id: string, expected: object = completedResponse) {
  const controller = new AbortController();
  const completed = vi.fn();
  const pending = run(controller.signal, id).then(completed);
  await vi.advanceTimersByTimeAsync(ms);
  const result = completed.mock.calls[0]?.[0];
  controller.abort();
  await pending;
  expect(result).toMatchObject(expected);
  return result;
}

describe("Google stream lifecycle", () => {
  beforeEach(() => {
    guardedFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: "terminal marker",
      events: [
        { responseId: "fixture-response", usageMetadata: { promptTokenCount: 10 } },
        terminal,
        "[DONE]",
        quotaError,
      ],
      expected: { ...completedResponse, responseId: "fixture-response", usage: { input: 10 } },
    },
    {
      name: "blocked prompt",
      events: [{ promptFeedback: { blockReason: "SAFETY" } }],
      expected: { stopReason: "error", errorCode: "SAFETY" },
    },
  ])("releases the open body after $name", async ({ events, expected }) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    guardedFetch.mockResolvedValueOnce(response(events, cancel, true));
    await advanceResponse(1, "gemini-3.1-pro-preview", expected);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rotates keys on the first provider frame's quota status", async () => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "fixture-key-2");
    guardedFetch
      .mockResolvedValueOnce(response([quotaError]))
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    const result = await run(new AbortController().signal);
    expect(result).toMatchObject(completedResponse);
    expect(
      guardedFetch.mock.calls.map(([, init]) => new Headers(init.headers).get("x-goog-api-key")),
    ).toEqual(["fixture-key-1", "fixture-key-2"]);
    expect(guardedFetch.mock.calls[1]?.[1].body).toBe(guardedFetch.mock.calls[0]?.[1].body);
  });

  it("keeps the deadline while only metadata and empty content arrive", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    const cancel = vi.fn();
    guardedFetch
      .mockResolvedValueOnce(
        response(
          [
            { usageMetadata: { promptTokenCount: 10 } },
            { candidates: [{ finishReason: "" }] },
            { candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }] },
            { candidates: [{ content: { parts: [{ text: "" }] } }] },
          ],
          cancel,
          true,
        ),
      )
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    await advanceResponse(11, "gemini-3.1-pro-preview");
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      JSON.parse(guardedFetch.mock.calls[1]?.[1].body).generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: "LOW" });
  });
});
