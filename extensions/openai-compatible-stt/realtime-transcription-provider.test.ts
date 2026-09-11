// Tests for the universal OpenAI-compatible realtime transcription provider.
// These tests stub out the WebSocket transport so the protocol translation
// layer (binary audio out, JSON events in, partial/final transcript handling)
// can be exercised without a real STT service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiCompatibleRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

type ProviderOptions = Parameters<
  Parameters<
    typeof buildOpenAiCompatibleRealtimeTranscriptionProvider
  >[0]["createRealtimeTranscriptionWebSocketSession"]
>[0];
const recordings: Array<{
  url: string;
  headers: ProviderOptions["headers"];
  sentBinary: Buffer[];
  sentText: unknown[];
  emit: (event: unknown) => void;
}> = [];
function lastSocket() {
  const recording = recordings.at(-1);
  if (!recording) {
    throw new Error("expected a recorded session");
  }
  return recording;
}
function createRecordingSessionFactory() {
  return (options: ProviderOptions) => {
    const sentBinary: Buffer[] = [];
    const sentText: unknown[] = [];
    const transport = {
      callbacks: options.callbacks,
      sendBinary: (audio: Buffer) => {
        sentBinary.push(audio);
        return true;
      },
      sendJson: (event: unknown) => {
        sentText.push(event);
        return true;
      },
      closeNow: vi.fn(),
      isOpen: () => true,
      isReady: () => true,
      markReady: vi.fn(),
      failConnect: vi.fn(),
    };
    const url = typeof options.url === "function" ? options.url() : options.url;
    if (typeof url !== "string") {
      throw new Error("expected synchronous URL");
    }
    recordings.push({
      url,
      headers: options.headers,
      sentBinary,
      sentText,
      emit: (event) => {
        const parsed = options.parseMessage?.(Buffer.from(JSON.stringify(event)));
        if (parsed) {
          options.onMessage?.(parsed, transport);
        }
      },
    });
    return {
      connect: async () => {
        options.onOpen?.(transport);
      },
      sendAudio: (audio: Buffer) => options.sendAudio(audio, transport),
      close: () => options.onClose?.(transport),
      isConnected: () => true,
    };
  };
}

describe("openai-compatible-stt provider", () => {
  const originalEndpoint = process.env.OPENAI_COMPATIBLE_STT_ENDPOINT;
  const originalApiKey = process.env.OPENAI_COMPATIBLE_STT_API_KEY;

  beforeEach(() => {
    recordings.length = 0;
    delete process.env.OPENAI_COMPATIBLE_STT_ENDPOINT;
    delete process.env.OPENAI_COMPATIBLE_STT_API_KEY;
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OPENAI_COMPATIBLE_STT_ENDPOINT;
    } else {
      process.env.OPENAI_COMPATIBLE_STT_ENDPOINT = originalEndpoint;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_STT_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_STT_API_KEY = originalApiKey;
    }
  });

  it("registers with the expected id and aliases", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(provider.id).toBe("openai-compatible-stt");
    expect(provider.aliases).toEqual(
      expect.arrayContaining(["local-stt", "whisper-local", "openai-compat-stt"]),
    );
    expect(provider.label).toContain("universal");
    expect(provider.autoSelectOrder).toBe(80);
    expect(provider.defaultModel).toBe("whisper-1");
  });

  it("isConfigured requires a resolved endpoint", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: { endpoint: "http://127.0.0.1:8765/ws/transcribe" },
      }),
    ).toBe(true);
  });

  it("throws when createSession is called without an endpoint", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(/endpoint URL/i);
  });

  it("translates http endpoint to ws and converts relay μ-law to PCM16", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "http://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onSpeechStart: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    expect(socket.url).toBe(
      "ws://127.0.0.1:8765/ws/transcribe?encoding=pcm_s16le&model=whisper-1&sample_rate=16000&interim_results=true",
    );
    const audio = Buffer.alloc(160, 0xff);
    session.sendAudio(audio);
    // Sending audio never emits text frames beyond the open-time config
    // message that negotiates the PCM framing.
    expect(socket.sentText).toEqual([{ type: "config", encoding: "pcm16", sample_rate: 16000 }]);
    // The SDK streaming resampler holds back its right edge until more input
    // arrives (or the session flushes), so the exact sample count is asserted
    // after close rather than per frame.
    session.close();
    const totalBytes = socket.sentBinary.reduce((sum, frame) => sum + frame.length, 0);
    expect(totalBytes).toBe(640);
    for (const frame of socket.sentBinary) {
      expect(frame).toEqual(Buffer.alloc(frame.length));
    }
  });

  it("decodes non-zero μ-law samples, resamples, and preserves empty frames", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: {
        endpoint: "ws://127.0.0.1:8765/ws/transcribe",
        sampleRate: 8000,
      },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    session.sendAudio(Buffer.from([0x00, 0x80]));
    expect(socket.sentBinary[0]).toEqual(Buffer.from([0x84, 0x82, 0x7c, 0x7d]));
    session.sendAudio(Buffer.alloc(0));
    expect(socket.sentBinary[1]).toEqual(Buffer.alloc(0));
  });

  it("forwards an Authorization bearer header when an apiKey is configured", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    provider.createSession({
      providerConfig: {
        endpoint: "https://stt.example.test/ws/transcribe",
        apiKey: "test-key",
      },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    expect(socket.url?.startsWith("wss://stt.example.test/")).toBe(true);
    expect(socket.headers).toEqual({ Authorization: "Bearer test-key" });
  });

  it("emits partial transcripts and finalizes them", () => {
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const onError = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial,
      onTranscript,
      onSpeechStart,
      onError,
    });

    lastSocket().emit({ type: "speech_start" });
    expect(onSpeechStart).toHaveBeenCalledOnce();

    lastSocket().emit({ type: "partial", text: "hello" });
    expect(onPartial).toHaveBeenLastCalledWith("hello");

    lastSocket().emit({ type: "partial", text: "hello world" });
    expect(onPartial).toHaveBeenLastCalledWith("hello world");

    lastSocket().emit({ type: "final", text: "hello world" });
    expect(onTranscript).toHaveBeenLastCalledWith("hello world");
    expect(onPartial).toHaveBeenCalledTimes(2);

    // After a final, a new partial should not include the previous text.
    lastSocket().emit({ type: "partial", text: "goodbye" });
    expect(onPartial).toHaveBeenLastCalledWith("goodbye");
  });

  it("emits an error when the server sends an error event", () => {
    const onError = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError,
    });
    lastSocket().emit({ type: "error", message: "model crashed" });
    expect(onError).toHaveBeenCalledOnce();
    const firstError = onError.mock.calls[0]?.[0];
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe("model crashed");
  });

  it("commits on close and emits only the server final", () => {
    const onTranscript = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript,
      onError: vi.fn(),
    });
    lastSocket().emit({ type: "partial", text: "in flight" });
    session.close();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(lastSocket().sentText).toContainEqual({ type: "commit" });
    session.close();
    expect(lastSocket().sentText).toEqual([
      { type: "config", encoding: "pcm16", sample_rate: 16000 },
      { type: "commit" },
    ]);
    lastSocket().emit({ type: "final", text: "in flight corrected" });
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("in flight corrected");
  });
  it("rejects an unresolved explicit credential before selecting an environment key", () => {
    process.env.OPENAI_COMPATIBLE_STT_API_KEY = "fallback-key";
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(() =>
      provider.createSession({
        providerConfig: {
          endpoint: "ws://stt.example.test/transcribe",
          apiKey: { source: "env", provider: "default", id: "MISSING_STT_KEY" },
        },
      }),
    ).toThrow(/unresolved SecretRef/);
    expect(recordings).toHaveLength(0);
  });

  it("rejects an explicit non-string credential before opening a session", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(() =>
      provider.createSession({
        providerConfig: {
          endpoint: "ws://stt.example.test/transcribe",
          apiKey: 42 as unknown as string,
        },
      }),
    ).toThrow(/apiKey must be a string/);
    expect(recordings).toHaveLength(0);
  });

  it("rejects an unresolved SecretRef at the resolveConfig normalization boundary", () => {
    process.env.OPENAI_COMPATIBLE_STT_API_KEY = "fallback-key";
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    // The object must be rejected BEFORE provider normalization collapses it
    // to undefined (which would enable environment-token fallback).
    expect(() =>
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: {
          endpoint: "ws://stt.example.test/transcribe",
          apiKey: { source: "env", provider: "default", id: "MISSING_STT_KEY" },
        },
      }),
    ).toThrow(/unresolved SecretRef/);
  });

  it("keeps streaming resampler sample counts drift-free across frames", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe", sampleRate: 11025 },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    for (let index = 0; index < 10; index += 1) {
      session.sendAudio(Buffer.alloc(160, 0xff));
    }
    // Flush releases the held-back right edge; only after it is the cumulative
    // sample count exact.
    session.close();
    const totalSamples = socket.sentBinary.reduce((sum, frame) => sum + frame.length / 2, 0);
    // 10 frames x 160 samples = 1,600 input samples; 1,600 x 11025/8000 =
    // 2,205 output samples. Per-frame rounding would drift to 2,210.
    expect(totalSamples).toBe(2205);
  });

  it("flushes the resampler tail before the commit control message", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe", sampleRate: 11025 },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    session.sendAudio(Buffer.alloc(160, 0xff));
    session.close();
    expect(socket.sentText).toEqual([
      { type: "config", encoding: "pcm16", sample_rate: 11025 },
      { type: "commit" },
    ]);
    // The flushed tail must land before the commit request.
    const lastBinary = socket.sentBinary.at(-1);
    expect(lastBinary).toBeInstanceOf(Buffer);
    expect(lastBinary?.length ?? 0).toBeGreaterThan(0);
  });
});
