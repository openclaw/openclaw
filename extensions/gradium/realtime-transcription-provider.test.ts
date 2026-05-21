import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RealtimeTranscriptionWebSocketTransport } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildGradiumRealtimeTranscriptionProvider,
} from "./realtime-transcription-provider.js";

describe("buildGradiumRealtimeTranscriptionProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("normalizes nested provider config", () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as OpenClawConfig,
      rawConfig: {
        providers: {
          gradium: {
            apiKey: "gsk_test",
            model_name: "default",
            input_format: "pcm",
            language: "en",
            temp: 0.2,
            padding_bonus: 0.4,
            delay_in_frames: "20",
            semantic_vad: "false",
            semantic_vad_threshold: "0.7",
            semantic_vad_horizon_index: "1",
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      apiKey: "gsk_test",
      modelName: "default",
      inputFormat: "pcm",
      language: "en",
      temp: 0.2,
      paddingBonus: 0.4,
      delayInFrames: 20,
      semanticVad: false,
      semanticVadThreshold: 0.7,
      semanticVadHorizonIndex: 1,
    });
  });

  it("rejects unknown input formats", () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    expect(() =>
      provider.resolveConfig?.({
        cfg: {} as OpenClawConfig,
        rawConfig: { providers: { gradium: { input_format: "mp3" } } },
      }),
    ).toThrow("Invalid Gradium realtime transcription input format: mp3");
  });

  it("rejects delay values Gradium does not accept", () => {
    const provider = buildGradiumRealtimeTranscriptionProvider();
    expect(() =>
      provider.resolveConfig?.({
        cfg: {} as OpenClawConfig,
        rawConfig: { providers: { gradium: { delay_in_frames: 2 } } },
      }),
    ).toThrow("Invalid Gradium realtime transcription delayInFrames: 2");
  });

  it("builds a Gradium ASR websocket URL", () => {
    const url = __testing.toGradiumRealtimeWsUrl({
      baseUrl: "https://api.gradium.ai",
    });

    expect(url).toBe("wss://api.gradium.ai/api/speech/asr");
  });

  it("includes language in the setup payload when configured", () => {
    const setup = __testing.buildSetupPayload({
      modelName: "default",
      inputFormat: "pcm",
      language: "en",
      temp: 0.2,
      paddingBonus: 0.4,
      delayInFrames: 20,
    });

    expect(setup).toEqual({
      type: "setup",
      model_name: "default",
      input_format: "pcm",
      json_config: JSON.stringify({
        language: "en",
        temp: 0.2,
        padding_bonus: 0.4,
        delay_in_frames: 20,
      }),
    });
  });

  it("uses Gradium semantic VAD steps to flush and commit a final transcript", () => {
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const sendJson = vi.fn(() => true);
    const transport = {
      callbacks: {},
      closeNow: vi.fn(),
      failConnect: vi.fn(),
      isOpen: vi.fn(() => true),
      isReady: vi.fn(() => true),
      markReady: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendJson,
    } satisfies RealtimeTranscriptionWebSocketTransport;

    const handleEvent = __testing.createGradiumRealtimeEventHandler({
      providerConfig: {
        apiKey: "gsk_test",
        language: "en",
        inputFormat: "ulaw_8000",
      },
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      modelName: "default",
      inputFormat: "ulaw_8000",
      language: "en",
      semanticVad: true,
      semanticVadThreshold: 0.5,
      semanticVadHorizonIndex: 2,
      onPartial,
      onTranscript,
      onSpeechStart,
    });

    handleEvent({ type: "ready" }, transport);
    handleEvent({ type: "text", text: "hello" }, transport);
    handleEvent({ type: "text", text: " " }, transport);
    handleEvent({ type: "text", text: "openclaw" }, transport);
    handleEvent(
      {
        type: "step",
        vad: [{ inactivity_prob: 0.05 }, { inactivity_prob: 0.2 }, { inactivity_prob: 0.92 }],
      },
      transport,
    );
    handleEvent({ type: "end_text" }, transport);

    expect(transport.markReady).toHaveBeenCalledTimes(1);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith("hello");
    expect(onPartial).toHaveBeenCalledWith("hello openclaw");
    expect(sendJson).toHaveBeenCalledWith({ type: "flush", flush_id: 1 });
    expect(onTranscript).toHaveBeenCalledWith("hello openclaw");

    handleEvent({ type: "flushed" }, transport);

    expect(onTranscript).toHaveBeenCalledTimes(1);
  });

  it("schedules a semantic fallback flush after end_text without changing chunk spacing", () => {
    vi.useFakeTimers();

    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const sendJson = vi.fn(() => true);
    const transport = {
      callbacks: {},
      closeNow: vi.fn(),
      failConnect: vi.fn(),
      isOpen: vi.fn(() => true),
      isReady: vi.fn(() => true),
      markReady: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendJson,
    } satisfies RealtimeTranscriptionWebSocketTransport;

    const handleEvent = __testing.createGradiumRealtimeEventHandler({
      providerConfig: { apiKey: "gsk_test" },
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      modelName: "default",
      inputFormat: "ulaw_8000",
      semanticVad: true,
      semanticVadThreshold: 0.5,
      semanticVadHorizonIndex: 2,
      onPartial,
      onTranscript,
    });

    handleEvent({ type: "text", text: "hello" }, transport);
    handleEvent({ type: "text", text: "," }, transport);
    handleEvent({ type: "text", text: " world" }, transport);
    handleEvent({ type: "end_text" }, transport);

    expect(onPartial).toHaveBeenLastCalledWith("hello, world");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(sendJson).not.toHaveBeenCalledWith({ type: "flush", flush_id: 1 });

    vi.advanceTimersByTime(900);

    expect(sendJson).toHaveBeenCalledWith({ type: "flush", flush_id: 1 });

    handleEvent({ type: "flushed" }, transport);

    expect(onTranscript).toHaveBeenCalledWith("hello, world");
  });

  it("commits an end_text transcript when no semantic flush is pending", () => {
    const onTranscript = vi.fn();
    const transport = {
      callbacks: {},
      closeNow: vi.fn(),
      failConnect: vi.fn(),
      isOpen: vi.fn(() => true),
      isReady: vi.fn(() => true),
      markReady: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendJson: vi.fn(() => true),
    } satisfies RealtimeTranscriptionWebSocketTransport;

    const handleEvent = __testing.createGradiumRealtimeEventHandler({
      providerConfig: { apiKey: "gsk_test" },
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      modelName: "default",
      inputFormat: "ulaw_8000",
      semanticVad: false,
      semanticVadThreshold: 0.5,
      semanticVadHorizonIndex: 2,
      onTranscript,
    });

    handleEvent({ type: "text", text: "fallback turn" }, transport);
    handleEvent({ type: "end_text" }, transport);

    expect(transport.sendJson).not.toHaveBeenCalledWith({ type: "flush", flush_id: 1 });
    expect(onTranscript).toHaveBeenCalledWith("fallback turn");
  });

  it("commits pending text when a reconnect ready event starts a fresh stream", () => {
    const onTranscript = vi.fn();
    const transport = {
      callbacks: {},
      closeNow: vi.fn(),
      failConnect: vi.fn(),
      isOpen: vi.fn(() => true),
      isReady: vi.fn(() => true),
      markReady: vi.fn(),
      sendBinary: vi.fn(() => true),
      sendJson: vi.fn(() => true),
    } satisfies RealtimeTranscriptionWebSocketTransport;

    const handleEvent = __testing.createGradiumRealtimeEventHandler({
      providerConfig: { apiKey: "gsk_test" },
      apiKey: "gsk_test",
      baseUrl: "https://api.gradium.ai",
      modelName: "default",
      inputFormat: "ulaw_8000",
      semanticVad: true,
      semanticVadThreshold: 0.5,
      semanticVadHorizonIndex: 2,
      onTranscript,
    });

    handleEvent({ type: "text", text: "pending turn" }, transport);
    handleEvent({ type: "ready" }, transport);
    handleEvent({ type: "text", text: "fresh turn" }, transport);
    handleEvent({ type: "end_of_stream" }, transport);

    expect(transport.markReady).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenNthCalledWith(1, "pending turn");
    expect(onTranscript).toHaveBeenNthCalledWith(2, "fresh turn");
  });

  it("requires an API key when creating sessions", () => {
    vi.stubEnv("GRADIUM_API_KEY", "");
    const provider = buildGradiumRealtimeTranscriptionProvider();
    expect(() => provider.createSession({ providerConfig: {} })).toThrow("Gradium API key missing");
  });
});
