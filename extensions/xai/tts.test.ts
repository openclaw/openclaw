// Xai tests cover tts plugin behavior.
import { EventEmitter } from "node:events";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { isValidXaiTtsVoice, XAI_BASE_URL, XAI_TTS_VOICES, xaiTTS, xaiTTSStream } from "./tts.js";

type XaiTtsStreamOptions = Parameters<typeof xaiTTSStream>[0];
type XaiTtsWebSocketFactory = NonNullable<XaiTtsStreamOptions["websocketFactory"]>;

class FakeTtsWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeTtsWebSocket.CONNECTING;
  readonly sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeTtsWebSocket.OPEN;
    this.emit("open");
  }

  message(event: Record<string, unknown>) {
    this.emit("message", JSON.stringify(event));
  }
}

function createStreamingAudioResponse(params: {
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): { response: Response; getReadCount: () => number } {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(params.chunkSize).fill(params.byte));
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }),
    getReadCount: () => reads,
  };
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
    vi.restoreAllMocks();
  });

  describe("isValidXaiTtsVoice", () => {
    it("accepts all valid voices", () => {
      for (const voice of XAI_TTS_VOICES) {
        expect(isValidXaiTtsVoice(voice)).toBe(true);
      }
    });

    it("rejects invalid voice names", () => {
      expect(isValidXaiTtsVoice("invalid")).toBe(false);
      expect(isValidXaiTtsVoice("")).toBe(false);
      expect(isValidXaiTtsVoice("ALLOY")).toBe(false);
      expect(isValidXaiTtsVoice("alloy ")).toBe(false);
      expect(isValidXaiTtsVoice(" alloy")).toBe(false);
    });

    it("treats custom endpoints as permissive", () => {
      expect(isValidXaiTtsVoice("grok-voice-custom", "https://custom.api.x.ai/v1")).toBe(true);
    });
  });

  describe("xaiTTS diagnostics", () => {
    it("includes parsed provider detail and request id for JSON API errors", async () => {
      const fetchMock = vi.fn(
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
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        xaiTTS({
          text: "hello",
          apiKey: "bad-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(
        "xAI TTS API error (401): Invalid API key [type=invalid_request_error, code=invalid_api_key] [request_id=req_123]",
      );
    });

    it("sends an openclaw User-Agent on xAI TTS requests", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(Buffer.from("audio-bytes"), {
            status: 200,
            headers: { "Content-Type": "audio/mpeg" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await xaiTTS({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "en",
        responseFormat: "mp3",
        timeoutMs: 5_000,
      });

      const init = fetchMock.mock.calls.at(0)?.[1];
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get("user-agent")).toBe("openclaw/2026.3.22");
      expect(headers.get("authorization")).toBe("Bearer ok-key");
      vi.unstubAllEnvs();
    });

    it("caps streamed audio responses instead of buffering oversized TTS output", async () => {
      const streamed = createStreamingAudioResponse({
        chunkCount: 20,
        chunkSize: 1024,
        byte: 121,
      });
      const fetchMock = vi.fn(async () => streamed.response);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        xaiTTS({
          text: "hello",
          apiKey: "ok-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
          maxBytes: 2048,
        }),
      ).rejects.toThrow("xAI TTS audio response exceeds 2048 bytes");

      expect(streamed.getReadCount()).toBeLessThan(20);
    });

    it("falls back to raw body text when the error body is non-JSON", async () => {
      const fetchMock = vi.fn(
        async () => new Response("temporary upstream outage", { status: 503 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        xaiTTS({
          text: "hello",
          apiKey: "test-key",
          baseUrl: XAI_BASE_URL,
          voiceId: "eve",
          language: "en",
          responseFormat: "mp3",
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow("xAI TTS API error (503): temporary upstream outage");
    });
  });

  describe("xaiTTSStream", () => {
    function createSocketHarness() {
      const sockets: FakeTtsWebSocket[] = [];
      const factory: ReturnType<typeof vi.fn<XaiTtsWebSocketFactory>> = vi.fn(() => {
        const socket = new FakeTtsWebSocket();
        sockets.push(socket);
        return socket as ReturnType<XaiTtsWebSocketFactory>;
      });
      return { sockets, factory };
    }

    async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    }

    it("uses the native xAI TTS WebSocket URL and sends text.delta before text.done", async () => {
      vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
      const { sockets, factory } = createSocketHarness();
      const resultPromise = xaiTTSStream({
        text: "hello stream",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        language: "auto",
        speed: 1.2,
        responseFormat: "pcm",
        timeoutMs: 5_000,
        websocketFactory: factory,
      });

      sockets[0]?.open();
      const result = await resultPromise;
      sockets[0]?.message({
        type: "audio.delta",
        delta: Buffer.from([1, 2, 3]).toString("base64"),
      });
      sockets[0]?.message({ type: "audio.done" });

      const url = new URL(factory.mock.calls[0]?.[0] ?? "");
      expect(url.toString()).toBe(
        "wss://api.x.ai/v1/tts?language=auto&voice=eve&codec=pcm&speed=1.2",
      );
      expect(factory.mock.calls[0]?.[1]).toMatchObject({
        headers: {
          Authorization: "Bearer ok-key",
          "User-Agent": "openclaw/2026.3.22",
        },
        handshakeTimeout: 5_000,
      });
      expect(sockets[0]?.sent.map((data) => JSON.parse(data) as unknown)).toEqual([
        { type: "text.delta", delta: "hello stream" },
        { type: "text.done" },
      ]);
      await expect(readAll(result.audioStream)).resolves.toEqual(Buffer.from([1, 2, 3]));
      vi.unstubAllEnvs();
    });

    it("rejects non-native base URLs for streaming TTS", async () => {
      await expect(
        xaiTTSStream({
          text: "hello",
          apiKey: "ok-key",
          baseUrl: "https://proxy.example.test/v1",
          voiceId: "eve",
          timeoutMs: 5_000,
          websocketFactory: vi.fn(),
        }),
      ).rejects.toThrow("xAI streaming TTS requires native xAI baseUrl https://api.x.ai/v1");
    });

    it("errors the audio stream when the connection closes before audio.done", async () => {
      const { sockets, factory } = createSocketHarness();
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 5_000,
        websocketFactory: factory,
      });
      sockets[0]?.open();
      const result = await resultPromise;
      sockets[0]?.emit("close");

      await expect(readAll(result.audioStream)).rejects.toThrow(
        "xAI streaming TTS connection closed before audio.done",
      );
    });

    it("times out connection setup and releases the socket", async () => {
      vi.useFakeTimers();
      const { sockets, factory } = createSocketHarness();
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 50,
        websocketFactory: factory,
      });
      const expectation = expect(resultPromise).rejects.toThrow("xAI streaming TTS timed out");

      await vi.advanceTimersByTimeAsync(50);

      await expectation;
      expect(sockets[0]?.close).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("closes the socket when the caller releases the stream", async () => {
      const { sockets, factory } = createSocketHarness();
      const resultPromise = xaiTTSStream({
        text: "hello",
        apiKey: "ok-key",
        baseUrl: XAI_BASE_URL,
        voiceId: "eve",
        timeoutMs: 5_000,
        websocketFactory: factory,
      });
      sockets[0]?.open();
      const result = await resultPromise;

      await result.release();

      expect(sockets[0]?.close).toHaveBeenCalledWith(1000, "tts complete");
    });
  });
});
