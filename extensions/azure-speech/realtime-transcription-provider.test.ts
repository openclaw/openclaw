import type {
  PushAudioInputStream,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import catalog from "./capability-catalog.js";
import { buildAzureSpeechTranscriptionProvider } from "./realtime-transcription-provider.js";

const sdkState = vi.hoisted(() => ({
  loaded: false,
  started: Promise.withResolvers<void>(),
  start: undefined as (() => void) | undefined,
  rejectStart: undefined as ((message: string) => void) | undefined,
  recognizer: undefined as SpeechRecognizer | undefined,
  stream: undefined as PushAudioInputStream | undefined,
  write: undefined as MockInstance<PushAudioInputStream["write"]> | undefined,
  closeInput: undefined as MockInstance<PushAudioInputStream["close"]> | undefined,
  closeRecognizer: vi.fn<(callback?: () => void, error?: (message: string) => void) => void>(),
}));

vi.mock("microsoft-cognitiveservices-speech-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("microsoft-cognitiveservices-speech-sdk")>();
  sdkState.loaded = true;
  return {
    ...sdk,
    AudioInputStream: {
      createPushStream: vi.fn((format) => {
        const stream = sdk.AudioInputStream.createPushStream(format);
        sdkState.write = vi.spyOn(stream, "write");
        sdkState.closeInput = vi.spyOn(stream, "close");
        sdkState.stream = stream;
        return stream;
      }),
    },
    SpeechRecognizer: class extends sdk.SpeechRecognizer {
      constructor(...args: ConstructorParameters<typeof sdk.SpeechRecognizer>) {
        super(...args);
        sdkState.recognizer = this;
      }
      override startContinuousRecognitionAsync = vi.fn(
        (callback?: () => void, error?: (message: string) => void) => {
          sdkState.start = callback;
          sdkState.rejectStart = error;
          sdkState.started.resolve();
        },
      );
      override close = sdkState.closeRecognizer;
    },
  };
});

const provider = buildAzureSpeechTranscriptionProvider();
const providerConfig = { apiKey: "azure-speech-test-key", region: "eastus" };

function createSession() {
  const callbacks = {
    onPartial: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onSpeechStart: vi.fn(),
  };
  return { session: provider.createSession({ providerConfig, ...callbacks }), callbacks };
}

async function startSession() {
  const result = createSession();
  const connecting = result.session.connect();
  await sdkState.started.promise;
  expect(sdkState.start).toBeTypeOf("function");
  sdkState.start?.();
  await connecting;
  return result;
}

async function emitFinal(text: string, id = "utterance-1") {
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const recognizer = sdkState.recognizer!;
  recognizer.recognized?.(
    recognizer,
    new sdk.SpeechRecognitionEventArgs(
      new sdk.SpeechRecognitionResult(id, sdk.ResultReason.RecognizedSpeech, text),
      0,
    ),
  );
}

async function finishSession() {
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const recognizer = sdkState.recognizer!;
  recognizer.sessionStopped?.(recognizer, new sdk.SessionEventArgs("test-session"));
}

describe("Azure Speech dashboard dictation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const key of [
      "AZURE_SPEECH_KEY",
      "AZURE_SPEECH_API_KEY",
      "SPEECH_KEY",
      "AZURE_SPEECH_REGION",
      "SPEECH_REGION",
    ]) {
      vi.stubEnv(key, undefined);
    }
    sdkState.start = undefined;
    sdkState.started = Promise.withResolvers<void>();
    sdkState.rejectStart = undefined;
    sdkState.recognizer = undefined;
    sdkState.stream = undefined;
    sdkState.write = undefined;
    sdkState.closeInput = undefined;
    sdkState.closeRecognizer.mockReset().mockImplementation((callback) => callback?.());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("discovers dictation without loading the SDK or requiring speech synthesis to be enabled", () => {
    const discovered = catalog.realtimeTranscriptionProviders.find(
      (entry) => entry.id === "azure-speech",
    );
    expect(
      discovered?.isConfigured({
        cfg: { tts: { auto: "off", providers: { "azure-speech": providerConfig } } },
        providerConfig: {},
      }),
    ).toBe(true);
    const { session } = createSession();
    expect(sdkState.loaded).toBe(false);
    session.close();
  });

  it("reuses existing credentials, honors overrides, and rejects an unresolved secret", () => {
    const cfg = { tts: { providers: { "azure-speech": { ...providerConfig, lang: "fr-FR" } } } };
    vi.stubEnv("AZURE_SPEECH_KEY", "env-key");
    vi.stubEnv("AZURE_SPEECH_REGION", "westus");
    expect(provider.resolveConfig?.({ cfg, rawConfig: {} })).toEqual({
      ...providerConfig,
      language: "fr-FR",
    });
    expect(
      provider.resolveConfig?.({
        cfg,
        rawConfig: { apiKey: "override-key", region: "westeurope", language: "de-DE" },
      }),
    ).toEqual({ apiKey: "override-key", region: "westeurope", language: "de-DE" });
    expect(provider.resolveConfig?.({ cfg: {}, rawConfig: {} })).toEqual({
      apiKey: "env-key",
      region: "westus",
      language: "en-US",
    });
    expect(() =>
      provider.createSession({
        cfg,
        providerConfig: { apiKey: { source: "file", provider: "default", id: "/speech/key" } },
      }),
    ).toThrow();
  });

  it.each([
    { apiKey: "test-key" },
    { region: "eastus" },
    { apiKey: "test-key", endpoint: "https://eastus.tts.speech.microsoft.com" },
    { apiKey: "test-key", region: "eastus.example.invalid/" },
  ])("does not advertise unusable credentials as ready: %j", (config) => {
    expect(provider.isConfigured({ providerConfig: config })).toBe(false);
    expect(() => provider.createSession({ providerConfig: config })).toThrow();
  });

  it("converts queued mu-law audio without sending unrelated Buffer bytes and drains final words once", async () => {
    const { session, callbacks } = createSession();
    const connecting = session.connect();
    const slab = Buffer.from([1, 255, 127, 128, 0, 2]);
    session.sendAudio(slab.subarray(1, 5));
    slab.fill(0);
    await sdkState.started.promise;
    sdkState.start?.();
    await connecting;
    expect(session.isConnected()).toBe(true);
    expect(sdkState.write).toHaveBeenCalledWith(
      Uint8Array.from([0, 0, 0, 0, 124, 125, 132, 130]).buffer,
    );
    const sdk = await import("microsoft-cognitiveservices-speech-sdk");
    const recognizer = sdkState.recognizer!;
    recognizer.recognizing?.(
      recognizer,
      new sdk.SpeechRecognitionEventArgs(
        new sdk.SpeechRecognitionResult("partial-1", sdk.ResultReason.RecognizingSpeech, "hello"),
        0,
      ),
    );
    expect(callbacks.onPartial).toHaveBeenCalledWith("hello");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    session.close();
    session.close();
    expect(session.isConnected()).toBe(false);
    expect(sdkState.closeInput).toHaveBeenCalledTimes(1);
    expect(sdkState.closeRecognizer).not.toHaveBeenCalled();
    await emitFinal("hello world");
    await emitFinal("hello world");
    await emitFinal("hello world", "utterance-2");
    expect(callbacks.onTranscript.mock.calls).toEqual([["hello world"], ["hello world"]]);
    await finishSession();
    await emitFinal("discard this", "late");
    expect(callbacks.onTranscript).toHaveBeenCalledTimes(2);
    expect(sdkState.closeRecognizer).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes queued speech when stopped during connection without leaving a recognizer alive", async () => {
    const { session, callbacks } = createSession();
    const connecting = session.connect();
    session.sendAudio(Buffer.from([255]));
    session.close();
    await sdkState.started.promise;
    sdkState.start?.();
    await connecting;
    expect(sdkState.write).toHaveBeenCalledTimes(1);
    expect(sdkState.closeInput).toHaveBeenCalledTimes(1);
    await emitFinal("short dictation");
    await finishSession();
    expect(callbacks.onTranscript).toHaveBeenCalledWith("short dictation");
    expect(sdkState.closeRecognizer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports authentication failure without leaking SDK error details", async () => {
    const { session, callbacks } = await startSession();
    const sdk = await import("microsoft-cognitiveservices-speech-sdk");
    const recognizer = sdkState.recognizer!;
    recognizer.canceled?.(
      recognizer,
      new sdk.SpeechRecognitionCanceledEventArgs(
        sdk.CancellationReason.Error,
        "secret-key-in-transport-error",
        sdk.CancellationErrorCode.AuthenticationFailure,
      ),
    );
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "Azure Speech authentication failed. Check the Speech resource key and region.",
      }),
    );
    expect(session.isConnected()).toBe(false);
    expect(sdkState.closeRecognizer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate a recognizer when an empty session closes before SDK loading", async () => {
    const { session, callbacks } = createSession();
    const connecting = session.connect();
    session.close();
    await connecting;
    await vi.dynamicImportSettled();
    expect(sdkState.recognizer).toBeUndefined();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses an unsupported model instead of silently ignoring it", () => {
    const config = provider.resolveConfig?.({
      cfg: {},
      rawConfig: { ...providerConfig, model: "custom" },
    });
    expect(() => provider.createSession({ providerConfig: config! })).toThrow("model override");
  });

  it("bounds a stalled connection and ignores late SDK readiness", async () => {
    const { session, callbacks } = createSession();
    const connecting = session.connect();
    const rejected = expect(connecting).rejects.toThrow("timed out");
    await sdkState.started.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    sdkState.start?.();
    expect(session.isConnected()).toBe(false);
    expect(sdkState.closeRecognizer).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
  });

  it("reports missing finalization and releases resources within the relay drain", async () => {
    const { session, callbacks } = await startSession();
    session.close();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("Final words may be missing") }),
    );
    expect(sdkState.closeRecognizer).toHaveBeenCalledTimes(1);
    await emitFinal("late words");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces SDK disconnect when a missing service turn-end stalls recognizer teardown", async () => {
    const { session } = await startSession();
    const sdk = await vi.importActual<typeof import("microsoft-cognitiveservices-speech-sdk")>(
      "microsoft-cognitiveservices-speech-sdk",
    );
    // Exercise the SDK's real close/stop implementation with only the missing
    // service response and network disconnect stubbed.
    const { ServiceRecognizerBase } =
      await import("microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.speech/ServiceRecognizerBase.js");
    const turnEnd = Promise.withResolvers<void>();
    vi.spyOn(ServiceRecognizerBase.prototype, "stopRecognizing").mockReturnValue(turnEnd.promise);
    const disconnect = vi.spyOn(ServiceRecognizerBase.prototype, "disconnect").mockResolvedValue();
    const recognizer = sdkState.recognizer!;
    sdkState.closeRecognizer.mockImplementation((callback, error) => {
      sdk.SpeechRecognizer.prototype.close.call(recognizer, callback, error);
    });
    try {
      session.close();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      turnEnd.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});
