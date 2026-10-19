import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { XAI_BASE_URL } from "./model-definitions.js";
import { listXaiTtsVoices, xaiTTS, xaiTTSStream } from "./tts.js";

const ttsRequest = {
  text: "hello",
  apiKey: "dummy",
  baseUrl: XAI_BASE_URL,
  voiceId: "eve",
  timeoutMs: 5_000,
};

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  class MockWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];

    constructor(
      readonly url?: string,
      readonly options?: { headers?: Record<string, string>; maxPayload?: number },
    ) {
      super();
      MockWebSocket.instances.push(this);
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.close();
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

// mock-isolation: Drive WebSocket lifecycle synchronously without opening network connections.
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  globalThis.fetch = fetchMock;
  return fetchMock;
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
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    globalThis.fetch = originalFetch;
    FakeWebSocket.instances = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("listXaiTtsVoices", () => {
    it("maps the authenticated catalog and sends the expected request", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.7.9");
      const fetchMock = mockFetch(
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

      const voices = await listXaiTtsVoices({
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1/",
      });

      expect(voices).toEqual([
        { id: "altair", name: "Altair", locale: "en", gender: "male" },
        { id: "celeste", name: "Celeste", locale: undefined, gender: undefined },
      ]);
      const call = fetchMock.mock.calls[0];
      if (!call) {
        throw new Error("expected voice catalog request");
      }
      const [input, init] = call;
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(requestUrl).toBe("https://api.x.ai/v1/tts/voices");
      expect(init?.method).toBe("GET");
      const headers = new Headers(init?.headers);
      expect(Object.fromEntries(headers)).toMatchObject({
        authorization: "Bearer xai-key",
        "user-agent": "openclaw/2026.7.9",
      });
      vi.unstubAllEnvs();
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
