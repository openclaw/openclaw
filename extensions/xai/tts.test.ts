import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { buildXaiSpeechProvider } from "./speech-provider.js";
import { listXaiTtsVoices, xaiTTS, xaiTTSStream } from "./tts.js";

const ttsRequest = {
  text: "hello",
  apiKey: "dummy",
  baseUrl: XAI_BASE_URL,
  voiceId: "eve",
  timeoutMs: 5_000,
};

const resolveKey = vi.hoisted(() =>
  vi.fn(async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: undefined })),
);
// mock-isolation: OAuth fallback responses are fixtures and must not read host credentials.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveKey,
}));
// mock-isolation: Requests supply credential availability independently of host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: () => false,
  isProviderAuthProfileConfiguredAsync: async () => false,
}));

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

// mock-isolation: Drive WebSocket lifecycle synchronously without opening network connections.
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));

const fetchMock = vi.fn<typeof fetch>();
function mockFetch(response: Response) {
  fetchMock.mockResolvedValue(response);
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function capturedRequest() {
  const [input, init] = fetchMock.mock.calls[0] ?? [];
  if (!input) {
    throw new Error("Expected provider HTTP request");
  }
  return {
    url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    method: init?.method,
    headers: Object.fromEntries(new Headers(init?.headers)),
    body: init?.body,
  };
}

function capturedJson(): unknown {
  const body = capturedRequest().body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body);
}

function synthesize(overrides: Partial<Parameters<typeof xaiTTS>[0]> = {}) {
  return xaiTTS({ ...ttsRequest, apiKey: "ok-key", ...overrides });
}

function stream(overrides: Partial<Parameters<typeof xaiTTSStream>[0]> = {}) {
  const pending = xaiTTSStream({ ...ttsRequest, ...overrides });
  const ws = FakeWebSocket.instances.at(0);
  return { pending, ws };
}

function emitAudio(ws: InstanceType<typeof FakeWebSocket> | undefined, delta: string) {
  ws?.emit("message", JSON.stringify({ type: "audio.delta", delta }));
}

async function openStream(overrides: Partial<Parameters<typeof xaiTTSStream>[0]> = {}) {
  const { pending, ws } = stream(overrides);
  ws?.emit("open");
  return { result: await pending, ws };
}

describe("xai tts", () => {
  const originalFetch = globalThis.fetch;
  let ssrfMock: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
    vi.stubEnv("XAI_API_KEY", undefined);
    vi.stubEnv("XAI_BASE_URL", undefined);
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    globalThis.fetch = originalFetch;
    FakeWebSocket.instances = [];
    FakeWebSocket.onCreate = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    resolveKey.mockReset().mockResolvedValue({ apiKey: undefined });
    fetchMock.mockReset();
    vi.unstubAllEnvs();
  });

  describe("image generation", () => {
    const provider = buildXaiImageGenerationProvider();
    type Request = Parameters<typeof provider.generateImage>[0];
    const config = (overrides: { apiKey?: string; baseUrl?: string }) => ({
      models: { providers: { xai: { baseUrl: XAI_BASE_URL, models: [], ...overrides } } },
    });
    const inputImage = (value: string, mimeType = "image/png") => ({
      buffer: Buffer.from(value),
      mimeType,
    });
    function generate(overrides: Partial<Request> = {}) {
      return provider.generateImage({
        provider: "xai",
        model: "grok-imagine-image",
        prompt: "Combine the references",
        cfg: {},
        ...overrides,
      });
    }
    function mockImage(mime_type?: string, b64_json = Buffer.from("testpng").toString("base64")) {
      mockFetch(Response.json({ data: [{ b64_json, mime_type }] }));
    }
    beforeEach(() => {
      vi.useFakeTimers();
      resolveKey.mockResolvedValue({ apiKey: "xai-key" });
      mockImage();
    });

    it("builds provider metadata and resolves configuration", async () => {
      expect(provider).toMatchObject({
        id: "xai",
        label: "xAI",
        defaultModel: "grok-imagine-image",
        defaultTimeoutMs: 600_000,
        models: ["grok-imagine-image", "grok-imagine-image-2.0", "grok-imagine-image-quality"],
        capabilities: {
          generate: { maxCount: 4, supportsAspectRatio: true },
          edit: { enabled: true, maxInputImages: 3 },
        },
      });
      expect(provider.capabilities.geometry?.aspectRatios).toEqual(
        "1:1 16:9 9:16 4:3 3:4 3:2 2:3 2:1 1:2 19.5:9 9:19.5 20:9 9:20".split(" "),
      );
      const configured = provider.isConfiguredAsync;
      if (!configured) {
        throw new Error("Expected image config predicate");
      }
      expect(await configured({})).toBe(false);
      expect(await configured({ cfg: config({ apiKey: "xai-image-test-key" }) })).toBe(true);
    });
    it.each([
      "grok-imagine-image",
      "grok-imagine-image-2.0",
      "grok-imagine-image-quality",
      "grok-imagine-image-future",
    ])("preserves model %s in the request and result", async (model) => {
      const timers = vi.spyOn(globalThis, "setTimeout");
      const result = await generate({
        model,
        aspectRatio: "20:9",
        resolution: "2K",
        cfg: config({ baseUrl: "https://custom.x.ai/v1" }),
      });
      expect(resolveKey).toHaveBeenCalledWith(expect.objectContaining({ provider: "xai" }));
      expect(result.model).toBe(model);
      expect(timers.mock.calls.map(([, delay]) => delay)).toContain(600_000);
      expect(capturedRequest()).toMatchObject({
        url: "https://custom.x.ai/v1/images/generations",
        method: "POST",
      });
      expect(capturedJson()).toMatchObject({ model, aspect_ratio: "20:9", resolution: "2k" });
    });
    it.each(["grok-imagine-image-2.0", "grok-imagine-image-quality"])(
      "sends %s edits as a singular image_url",
      async (model) => {
        mockImage(
          "image/png",
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4z0ABAAEfAG0B0xMAAAAASUVORK5CYII=",
        );
        await generate({ model, inputImages: [inputImage("fakeimage")] });
        expect(capturedRequest().url).toContain("/images/edits");
        expect(capturedJson()).toMatchObject({
          model,
          prompt: "Combine the references",
          image: { url: expect.stringContaining("data:image/png;base64,"), type: "image_url" },
          response_format: "b64_json",
        });
      },
    );
    it("uses a plural payload for multiple edit inputs", async () => {
      mockImage("image/png", Buffer.from("edited").toString("base64"));
      await generate({
        inputImages: [
          inputImage("first"),
          inputImage("second", "image/jpeg"),
          inputImage("third", "image/webp"),
        ],
      });
      expect(capturedRequest().url).toContain("/images/edits");
      expect(capturedJson()).toEqual(
        expect.objectContaining({
          images: ["png", "jpeg", "webp"].map((type) => ({
            url: expect.stringContaining(`data:image/${type};base64,`),
            type: "image_url",
          })),
        }),
      );
    });
    it("rejects more than three references before HTTP", async () => {
      await expect(
        generate({
          inputImages: Array.from({ length: 4 }, (_, index) => inputImage(`reference-${index}`)),
        }),
      ).rejects.toThrow("xAI image editing supports up to 3 reference images");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("speech provider", () => {
    const provider = buildXaiSpeechProvider();
    function request(overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest {
      return {
        text: "hello",
        cfg: {},
        providerConfig: { apiKey: "xai-key" },
        target: "audio-file",
        timeoutMs: 5_000,
        ...overrides,
      };
    }
    function audioResponse() {
      return mockFetch(new Response("audio-bytes", { headers: { "content-type": "audio/mpeg" } }));
    }

    it("streams alaw when requested by a compatible caller", async () => {
      const created = new Promise<InstanceType<typeof FakeWebSocket>>((resolve) => {
        FakeWebSocket.onCreate = resolve;
      });
      const pending = provider.streamSynthesize?.(
        request({ providerConfig: { apiKey: "xai-key", responseFormat: "alaw" } }),
      );
      const ws = await created;
      expect(new URL(ws.url ?? "").searchParams.get("codec")).toBe("alaw");
      ws.emit("open");
      const result = await pending;
      expect(result?.outputFormat).toBe("alaw");
      await result?.release?.();
    });

    it("honors voice, language, and speed overrides for telephony output", async () => {
      audioResponse();
      const result = await provider.synthesizeTelephony?.(
        request({
          providerConfig: {
            apiKey: "xai-key",
            baseUrl: XAI_BASE_URL,
            voiceId: "eve",
            language: "en",
            speed: 1,
          },
          providerOverrides: { voice: "aura", language: "es", speed: 1.2 },
        }),
      );
      expect(result).toEqual({
        audioBuffer: Buffer.from("audio-bytes"),
        outputFormat: "pcm",
        sampleRate: 24_000,
      });
      expect(capturedJson()).toMatchObject({
        voice_id: "aura",
        language: "es",
        speed: 1.2,
        output_format: { codec: "pcm" },
      });
    });

    it("drops malformed speed values before synthesis", async () => {
      audioResponse();
      await provider.synthesize(
        request({
          providerConfig: { apiKey: "xai-key", speed: 2 },
          providerOverrides: { speed: 0.5 },
        }),
      );
      expect(capturedJson()).not.toHaveProperty("speed");
    });

    it("treats blank direct credentials as absent across readiness and requests", async () => {
      vi.stubEnv("XAI_API_KEY", "   ");
      audioResponse();
      const providerConfig = { apiKey: "   " };
      expect(
        await provider.isConfiguredAsync?.({ cfg: {}, providerConfig, timeoutMs: 5_000 }),
      ).toBe(false);
      await expect(provider.listVoices?.({ apiKey: "   ", providerConfig })).resolves.toEqual(
        ["ara", "eve", "leo", "rex", "sal"].map((voice) => ({ id: voice, name: voice })),
      );
      await expect(provider.synthesize(request({ providerConfig }))).rejects.toThrow(
        "xAI credentials missing for TTS",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses cfg-scoped profile auth for synthesis", async () => {
      resolveKey.mockResolvedValue({ apiKey: "oauth-bearer" });
      const cfg = { agents: { defaults: {} } };
      audioResponse();
      await provider.synthesize(request({ cfg, providerConfig: {}, target: "voice-note" }));
      expect(resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
      expect(capturedRequest().headers.authorization).toBe("Bearer oauth-bearer");
    });
  });

  describe("listXaiTtsVoices", () => {
    it("maps the authenticated catalog and sends the expected request", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.7.9");
      resolveKey.mockResolvedValue({ apiKey: "oauth-bearer" });
      const cfg = { agents: { defaults: {} } };
      mockFetch(
        Response.json({
          voices: [
            { voice_id: "altair", name: "Altair", language: "en", gender: "male" },
            { voice_id: "  celeste  ", name: " Celeste " },
            { voice_id: " " },
            { name: "missing id" },
            null,
          ],
        }),
      );

      const voices = await buildXaiSpeechProvider().listVoices({
        cfg,
        providerConfig: {},
        baseUrl: "https://api.x.ai/v1/",
      });

      expect(voices).toEqual([
        { id: "altair", name: "Altair", locale: "en", gender: "male" },
        { id: "celeste", name: "Celeste", locale: undefined, gender: undefined },
      ]);
      expect(capturedRequest()).toMatchObject({
        url: "https://api.x.ai/v1/tts/voices",
        method: "GET",
        headers: { authorization: "Bearer oauth-bearer", "user-agent": "openclaw/2026.7.9" },
      });
      expect(resolveKey).toHaveBeenCalledWith({ provider: "xai", cfg });
    });

    it("rejects malformed catalog payloads", async () => {
      mockFetch(Response.json({ items: [] }));

      await expect(listXaiTtsVoices({ apiKey: "xai-key" })).rejects.toThrow(
        "xAI TTS voices: malformed JSON response",
      );
    });
  });

  describe("xaiTTSStream", () => {
    it("streams decoded audio chunks without buffering the full body", async () => {
      const { pending: resultPromise, ws } = stream({
        language: "en",
        responseFormat: "mp3",
        speed: 1.1,
        maxBytes: 3_000,
      });
      const wsUrl = new URL(ws?.url ?? "");
      expect(wsUrl).toMatchObject({ protocol: "wss:", pathname: "/v1/tts" });
      expect(Object.fromEntries(wsUrl.searchParams)).toMatchObject({
        voice: "eve",
        language: "en",
        codec: "mp3",
        speed: "1.1",
      });
      expect(ws?.options).toMatchObject({
        headers: { Authorization: "Bearer dummy" },
        maxPayload: 5_024,
      });
      ws?.emit("open");
      expect(ws?.sent).toEqual([
        JSON.stringify({ type: "text.delta", delta: "hello" }),
        JSON.stringify({ type: "text.done" }),
      ]);

      emitAudio(ws, Buffer.from("abc").toString("base64"));
      ws?.emit("message", JSON.stringify({ type: "audio.done", trace_id: "trace-1" }));

      const result = await resultPromise;
      const reader = result.audioStream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value ?? []).toString("utf8")).toBe("abc");
      expect(await reader.read()).toMatchObject({ done: true });
      await result.release();
    });

    it.each([
      {
        delta: "not-base64!",
        maxBytes: undefined,
        error: "xAI TTS stream returned malformed base64 audio data",
      },
      {
        delta: Buffer.from("abcdef").toString("base64"),
        maxBytes: 4,
        error: "xAI TTS audio stream exceeds 4 bytes",
      },
    ])("errors and releases invalid audio $delta", async ({ delta, maxBytes, error }) => {
      const { result, ws } = await openStream({ maxBytes });
      emitAudio(ws, delta);
      await expect(result.audioStream.getReader().read()).rejects.toThrow(error);
      expect(ws?.readyState).toBe(FakeWebSocket.CLOSED);
      await result.release();
    });

    it("rejects upgrade failures before streaming starts", async () => {
      const { pending: resultPromise, ws } = stream();
      ws?.emit("unexpected-response", {}, { statusCode: 401, statusMessage: "Unauthorized" });
      await expect(resultPromise).rejects.toThrow(
        "xAI TTS stream connection failed (401): Unauthorized",
      );
    });

    it.each([
      [
        "https://proxy.example/v1",
        'only supports the native api.x.ai endpoint; got host "proxy.example"',
      ],
      ["http://api.x.ai/v1", "only supports HTTPS for the native api.x.ai endpoint"],
      ["https://api.x.ai:8443/v1", `requires the supported ${XAI_BASE_URL} base URL`],
      ["https://api.x.ai/v1#fragment", `requires the supported ${XAI_BASE_URL} base URL`],
    ])("rejects unsupported endpoint %s before opening a WebSocket", async (baseUrl, error) => {
      await expect(xaiTTSStream({ ...ttsRequest, baseUrl })).rejects.toThrow(error);
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("fails promptly when the socket closes before open", async () => {
      const { pending: resultPromise, ws } = stream({ timeoutMs: 60_000 });
      ws?.emit("close");
      await expect(resultPromise).rejects.toThrow("xAI TTS stream connection closed before open");
    });

    it("closes idempotently when released before audio.done", async () => {
      const { result, ws } = await openStream();
      await result.release();
      ws?.emit("close");
      await result.release();
      await expect(result.audioStream.getReader().read()).resolves.toEqual({
        done: true,
        value: undefined,
      });
    });

    it("refreshes the synthesis idle timeout for each audio chunk", async () => {
      vi.useFakeTimers();
      const { result, ws } = await openStream();
      const reader = result.audioStream.getReader();

      vi.advanceTimersByTime(4_000);
      emitAudio(ws, Buffer.from("ok").toString("base64"));
      await reader.read();
      vi.advanceTimersByTime(4_999);

      const timeoutRead = reader.read();
      vi.advanceTimersByTime(1);
      await expect(timeoutRead).rejects.toThrow("xAI TTS stream synthesis timeout");
    });
  });

  it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
    const streamed = createStreamingResponse({
      chunkCount: 20,
      chunkSize: 1024,
      byte: 121,
      headers: { "Content-Type": "audio/mpeg" },
    });
    mockFetch(streamed.response);

    await expect(synthesize({ maxBytes: 2048 })).rejects.toThrow(
      "xAI TTS audio response exceeds 2048 bytes",
    );

    expect(streamed.getReadCount()).toBeLessThan(20);
  });
  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "empty audio", contentType: "audio/mpeg", body: "" },
  ])("rejects a successful $name response as synthesized audio", async ({ contentType, body }) => {
    mockFetch(new Response(body, { status: 200, headers: { "content-type": contentType } }));

    await expect(synthesize()).rejects.toThrow("xAI TTS API error: malformed audio response");
  });
});
