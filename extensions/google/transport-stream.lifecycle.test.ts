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
function response(events: unknown[], cancel = vi.fn(), open = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events
              .map(
                (event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
              )
              .join(""),
          ),
        );
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

describe("Google stream lifecycle", () => {
  beforeEach(() => {
    guardedFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each(["gemini-2.5-pro", "gemini-3.1-pro-preview"])(
    "finishes %s at a proxy terminal marker and releases its open body",
    async (id) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      guardedFetch.mockResolvedValueOnce(
        response(
          [
            terminal,
            "[DONE]",
            ...(id === "gemini-2.5-pro"
              ? []
              : [
                  {
                    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "late error" },
                  },
                ]),
          ],
          cancel,
          true,
        ),
      );
      const controller = new AbortController();
      const completed = vi.fn();
      const pending = run(controller.signal, id).then(completed);
      await vi.advanceTimersByTimeAsync(1);
      const result = completed.mock.calls[0]?.[0];
      controller.abort();
      await pending;
      expect(result).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "complete" }],
      });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("rotates keys on the first provider frame's quota status", async () => {
    vi.stubEnv("OPENCLAW_LIVE_GEMINI_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "fixture-key-2");
    guardedFetch
      .mockResolvedValueOnce(
        response([
          {
            error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Request denied" },
          },
        ]),
      )
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    const result = await run(new AbortController().signal);
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "complete" }],
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(
      guardedFetch.mock.calls.map(([, init]) => new Headers(init.headers).get("x-goog-api-key")),
    ).toEqual(["fixture-key-1", "fixture-key-2"]);
    expect(guardedFetch.mock.calls[1]?.[1].body).toBe(guardedFetch.mock.calls[0]?.[1].body);
  });

  it.each([
    { label: "usage only", chunk: { usageMetadata: { promptTokenCount: 10 } } },
    { label: "empty finish", chunk: { candidates: [{ finishReason: "" }] } },
    {
      label: "unspecified finish",
      chunk: { candidates: [{ finishReason: "FINISH_REASON_UNSPECIFIED" }] },
    },
    { label: "empty part", chunk: { candidates: [{ content: { parts: [{ text: "" }] } }] } },
  ])("keeps the first-response deadline after $label", async ({ chunk }) => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS", "10");
    const cancel = vi.fn();
    guardedFetch
      .mockResolvedValueOnce(response([chunk], cancel, true))
      .mockResolvedValueOnce(response([terminal, "[DONE]"]));
    const controller = new AbortController();
    const completed = vi.fn();
    const pending = run(controller.signal, "gemini-3.1-pro-preview").then(completed);
    await vi.advanceTimersByTimeAsync(11);
    const result = completed.mock.calls[0]?.[0];
    controller.abort();
    await pending;
    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "complete" }],
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      JSON.parse(guardedFetch.mock.calls[1]?.[1].body).generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: "LOW" });
  });

  it("releases a prefetched response when the prompt is blocked", async () => {
    const cancel = vi.fn();
    guardedFetch.mockResolvedValueOnce(
      response([{ promptFeedback: { blockReason: "SAFETY" } }], cancel, true),
    );
    expect(await run(new AbortController().signal, "gemini-3.1-pro-preview")).toMatchObject({
      stopReason: "error",
      errorCode: "SAFETY",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves metadata read before substantive content", async () => {
    guardedFetch.mockResolvedValueOnce(
      response([
        { responseId: "fixture-response", usageMetadata: { promptTokenCount: 10 } },
        terminal,
        "[DONE]",
      ]),
    );
    expect(await run(new AbortController().signal, "gemini-3.1-pro-preview")).toMatchObject({
      responseId: "fixture-response",
      stopReason: "stop",
      usage: { input: 10 },
    });
  });
});
