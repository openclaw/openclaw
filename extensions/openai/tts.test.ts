// Openai tests cover tts plugin behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createDebugProxyCaptureReaderAsync,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "openclaw/plugin-sdk/proxy-capture";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { createStreamingErrorResponse } from "../test-support/streaming-error-response.js";
import { openaiTTS } from "./tts.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async ({
    url,
    init,
  }: {
    url: string;
    init?: RequestInit;
  }): Promise<{ response: Response; release: () => Promise<void> }> => ({
    response: await globalThis.fetch(url, init),
    release: vi.fn(async () => {}),
  }),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

function synthesize(overrides: Partial<Parameters<typeof openaiTTS>[0]> = {}) {
  return openaiTTS({
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    responseFormat: "mp3",
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("openai tts", () => {
  const originalFetch = globalThis.fetch;
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openai-tts-capture-",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await openClawState.cleanup();
  });

  // Install after local teardown so the proxy snapshot is restored before the
  // state helper removes its directory and restores the outer environment.
  const proxyReset = installDebugProxyTestResetHooks();

  describe("openaiTTS diagnostics", () => {
    it("adds OpenClaw attribution headers to native OpenAI speech requests", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      const fetchMock = vi.fn<typeof fetch>(
        async (_url, _init) => new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock;

      await synthesize();

      const [url, initValue] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
      const init = expectDefined(initValue, "fetch init");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(url).toBe("https://api.openai.com/v1/audio/speech");
      expect(headers?.originator).toBe("openclaw");
      expect(headers?.version).toBe("2026.3.22");
      expect(headers?.["User-Agent"]).toBe("openclaw/2026.3.22");
    });

    it("sends instructions to custom OpenAI-compatible endpoints", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async (_url, _init) => new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock;

      await synthesize({
        baseUrl: "https://tts.example.com/v1",
        model: "tts-1",
        voice: "custom-voice",
        instructions: " Speak warmly ",
      });

      const [, init] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.instructions).toBe("Speak warmly");
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("custom-voice");
    });

    it("merges sanitized extraBody fields into TTS requests", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async (_url, _init) => new Response(Buffer.from("audio-bytes"), { status: 200 }),
      );
      globalThis.fetch = fetchMock;
      const extraBody = JSON.parse(
        '{"lang":"e","speed":1.2,"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}',
      ) as Record<string, unknown>;

      await synthesize({
        baseUrl: "https://tts.example.com/v1",
        model: "tts-1",
        voice: "custom-voice",
        speed: 1,
        extraBody,
      });

      const [, init] = expectDefined(fetchMock.mock.calls[0], "fetch call 0");
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.model).toBe("tts-1");
      expect(body.input).toBe("hello");
      expect(body.voice).toBe("custom-voice");
      expect(body.response_format).toBe("mp3");
      expect(body.lang).toBe("e");
      expect(body.speed).toBe(1.2);
      expect(Object.hasOwn(body, "__proto__")).toBe(false);
      expect(Object.hasOwn(body, "constructor")).toBe(false);
      expect(Object.hasOwn(body, "prototype")).toBe(false);
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("includes parsed provider detail and request id for JSON API errors", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "Invalid API key",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "x-request-id": "req_123",
              },
            },
          ),
      );
      globalThis.fetch = fetchMock;

      await expect(synthesize({ apiKey: "bad-key" })).rejects.toThrow(
        "OpenAI TTS API error (401): Invalid API key [type=invalid_request_error, code=invalid_api_key] [request_id=req_123]",
      );
    });

    it("falls back to raw body text when the error body is non-JSON", async () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response("temporary upstream outage", { status: 503 }),
      );
      globalThis.fetch = fetchMock;

      await expect(synthesize()).rejects.toThrow(
        "OpenAI TTS API error (503): temporary upstream outage",
      );
    });

    it.each([
      { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
      { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
      { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
      { name: "empty audio", contentType: "audio/mpeg", body: "" },
    ])(
      "rejects a successful $name response as synthesized audio",
      async ({ contentType, body }) => {
        globalThis.fetch = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(body, { status: 200, headers: { "content-type": contentType } }),
          );

        await expect(synthesize()).rejects.toThrow(
          "OpenAI TTS API error: malformed audio response",
        );
      },
    );

    it.each([
      { name: "audio content type", contentType: "audio/mpeg" },
      { name: "missing content type", contentType: undefined },
    ])("preserves nonempty $name speech responses", async ({ contentType }) => {
      const audio = Buffer.from("audio-bytes");
      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(audio, {
          status: 200,
          ...(contentType ? { headers: { "content-type": contentType } } : {}),
        }),
      );

      await expect(synthesize()).resolves.toEqual(audio);
    });

    it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
      const streamed = createStreamingErrorResponse({
        status: 200,
        chunkCount: 20,
        chunkSize: 1024,
        byte: 121,
      });
      const fetchMock = vi.fn<typeof fetch>(async () => streamed.response);
      globalThis.fetch = fetchMock;

      await expect(synthesize({ maxBytes: 2048 })).rejects.toThrow(
        "OpenAI TTS audio response exceeds 2048 bytes",
      );

      expect(streamed.getReadCount()).toBeLessThan(20);
    });

    it("caps streamed non-JSON error reads instead of consuming full response bodies", async () => {
      const streamed = createStreamingErrorResponse({
        status: 503,
        chunkCount: 200,
        chunkSize: 1024,
        byte: 120,
      });
      const fetchMock = vi.fn<typeof fetch>(async () => streamed.response);
      globalThis.fetch = fetchMock;

      await expect(synthesize()).rejects.toThrow("OpenAI TTS API error (503)");

      expect(streamed.getReadCount()).toBeLessThan(200);
    });

    it("records TTS exchanges in debug proxy capture mode", async () => {
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-session";

      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 }));

      await synthesize();

      await finalizeDebugProxyCaptureAsync();
      const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
      const events = await reader.getSessionEvents("tts-session", 10);
      expect(
        events.some((event) => event.kind === "request" && event.host === "api.openai.com"),
      ).toBe(true);
      expect(
        events.some((event) => event.kind === "response" && event.host === "api.openai.com"),
      ).toBe(true);
    });

    it("does not double-capture TTS exchanges when the global fetch patch is installed", async () => {
      proxyReset.captureProxyEnv();
      process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
      process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "tts-patched-session";

      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(Buffer.from("audio-bytes"), { status: 200 }));

      await initializeDebugProxyCaptureAsync("test");

      await synthesize();

      try {
        await finalizeDebugProxyCaptureAsync();
        const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
        const events = (await reader.getSessionEvents("tts-patched-session", 10)).filter(
          (event) => event.host === "api.openai.com",
        );
        expect(events).toHaveLength(2);
        const kinds = events.map((event) => String(event.kind)).toSorted();
        expect(kinds).toEqual(["request", "response"]);
      } finally {
        await finalizeDebugProxyCaptureAsync();
      }
    });
  });
});
