import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  createAzureSpeechRealtimeTranscriptionSession,
  type AzureSpeechCancellationEvent,
  type AzureSpeechPushStream,
  type AzureSpeechRealtimeSdk,
  type AzureSpeechRecognitionEvent,
  type AzureSpeechSpeechRecognizer,
} from "./realtime-transcription-provider.js";

type RecognizerHooks = {
  recognizer: AzureSpeechSpeechRecognizer;
  startSpy: ReturnType<typeof vi.fn>;
  stopSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
  speechConfigSetProperty: ReturnType<typeof vi.fn>;
  pushStream: AzureSpeechPushStream & {
    writeSpy: ReturnType<typeof vi.fn>;
    closeSpy: ReturnType<typeof vi.fn>;
  };
  fromConfigSpy: ReturnType<typeof vi.fn>;
  recognizerCtorSpy: ReturnType<typeof vi.fn>;
  speechConfigFromSubscriptionSpy: ReturnType<typeof vi.fn>;
  speechConfigFromEndpointSpy: ReturnType<typeof vi.fn>;
  audioFormatSpy: ReturnType<typeof vi.fn>;
  speechConfig: {
    speechRecognitionLanguage: string;
    setProperty: (id: number, val: string) => void;
  };
};

function createMockSdk(opts: { startsOk?: boolean; stopsOk?: boolean } = {}): {
  sdk: AzureSpeechRealtimeSdk;
  hooks: RecognizerHooks;
} {
  const startsOk = opts.startsOk ?? true;
  const stopsOk = opts.stopsOk ?? true;
  const writeSpy = vi.fn();
  const pushCloseSpy = vi.fn();
  const pushStream: AzureSpeechPushStream & {
    writeSpy: typeof writeSpy;
    closeSpy: typeof pushCloseSpy;
  } = {
    write: writeSpy,
    close: pushCloseSpy,
    writeSpy,
    closeSpy: pushCloseSpy,
  };
  const startSpy = vi.fn((success?: () => void, error?: (msg: string) => void) => {
    if (startsOk) {
      success?.();
    } else {
      error?.("simulated start failure");
    }
  });
  const stopSpy = vi.fn((success?: () => void, error?: (msg: string) => void) => {
    if (stopsOk) {
      success?.();
    } else {
      error?.("simulated stop failure");
    }
  });
  const recognizerCloseSpy = vi.fn();
  const recognizer: AzureSpeechSpeechRecognizer = {
    recognizing: () => undefined,
    recognized: () => undefined,
    canceled: () => undefined,
    sessionStarted: () => undefined,
    sessionStopped: () => undefined,
    speechStartDetected: () => undefined,
    startContinuousRecognitionAsync: startSpy,
    stopContinuousRecognitionAsync: stopSpy,
    close: recognizerCloseSpy,
  };
  const speechConfigSetProperty = vi.fn();
  const speechConfig = { speechRecognitionLanguage: "", setProperty: speechConfigSetProperty };
  const speechConfigFromSubscriptionSpy = vi.fn(() => speechConfig);
  const speechConfigFromEndpointSpy = vi.fn(() => speechConfig);
  const audioFormatSpy = vi.fn(() => ({ kind: "format" }));
  const recognizerCtorSpy = vi.fn(function (this: unknown) {
    return recognizer;
  });
  const fromConfigSpy = vi.fn(() => recognizer);
  const SpeechRecognizerCtor =
    recognizerCtorSpy as unknown as AzureSpeechRealtimeSdk["SpeechRecognizer"];
  (SpeechRecognizerCtor as unknown as { FromConfig: typeof fromConfigSpy }).FromConfig =
    fromConfigSpy;
  const sdk: AzureSpeechRealtimeSdk = {
    AudioFormatTag: { PCM: 1, MuLaw: 2, ALaw: 8 },
    AudioStreamFormat: { getWaveFormat: audioFormatSpy },
    AudioInputStream: { createPushStream: (_format) => pushStream },
    AudioConfig: { fromStreamInput: () => ({ kind: "audio-config" }) },
    SpeechConfig: {
      fromSubscription: speechConfigFromSubscriptionSpy,
      fromEndpoint: speechConfigFromEndpointSpy,
    },
    AutoDetectSourceLanguageConfig: {
      fromLanguages: (langs) => ({ kind: "auto-detect", langs }),
    },
    PropertyId: {
      SpeechServiceConnection_InitialSilenceTimeoutMs: 29,
      SpeechServiceConnection_EndSilenceTimeoutMs: 30,
    },
    ResultReason: { RecognizingSpeech: 2, RecognizedSpeech: 3, NoMatch: 0 },
    CancellationReason: { Error: 1, EndOfStream: 0 },
    SpeechRecognizer: SpeechRecognizerCtor,
  };
  return {
    sdk,
    hooks: {
      recognizer,
      startSpy,
      stopSpy,
      closeSpy: recognizerCloseSpy,
      speechConfigSetProperty,
      pushStream,
      fromConfigSpy,
      recognizerCtorSpy,
      speechConfigFromSubscriptionSpy,
      speechConfigFromEndpointSpy,
      audioFormatSpy,
      speechConfig,
    },
  };
}

const baseSessionConfig = {
  providerConfig: {},
  apiKey: "key",
  region: "eastus",
  language: "en-US",
  sampleRate: 8000 as number,
  encoding: "mulaw" as const,
  initialSilenceTimeoutMs: 5000,
  endSilenceTimeoutMs: 800,
};

describe("createAzureSpeechRealtimeTranscriptionSession — connect & config", () => {
  it("connects via fromSubscription with the requested language and silence settings", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      {
        ...baseSessionConfig,
        language: "zh-CN",
        sampleRate: 16000,
        encoding: "pcm",
        initialSilenceTimeoutMs: 4000,
        endSilenceTimeoutMs: 700,
      },
      { loadSdk: async () => sdk },
    );
    await session.connect();
    expect(hooks.speechConfigFromSubscriptionSpy).toHaveBeenCalledWith("key", "eastus");
    expect(hooks.speechConfig.speechRecognitionLanguage).toBe("zh-CN");
    expect(hooks.speechConfigSetProperty).toHaveBeenCalledWith(
      sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "4000",
    );
    expect(hooks.speechConfigSetProperty).toHaveBeenCalledWith(
      sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      "700",
    );
    expect(hooks.audioFormatSpy).toHaveBeenCalledWith(16000, 16, 1, sdk.AudioFormatTag.PCM);
    expect(hooks.recognizerCtorSpy).toHaveBeenCalledTimes(1);
    expect(hooks.startSpy).toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("uses fromEndpoint when endpoint is provided", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      {
        ...baseSessionConfig,
        region: undefined,
        endpoint: "https://my-resource.cognitiveservices.azure.com/",
      },
      { loadSdk: async () => sdk },
    );
    await session.connect();
    expect(hooks.speechConfigFromEndpointSpy).toHaveBeenCalledTimes(1);
    expect(hooks.speechConfigFromSubscriptionSpy).not.toHaveBeenCalled();
    const [urlArg, keyArg] = hooks.speechConfigFromEndpointSpy.mock.calls[0];
    expect(urlArg).toBeInstanceOf(URL);
    expect((urlArg as URL).toString()).toBe("https://my-resource.cognitiveservices.azure.com/");
    expect(keyArg).toBe("key");
    session.close();
  });

  it("uses FromConfig with auto-detect when candidateLanguages is set", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, candidateLanguages: ["en-US", "zh-CN"] },
      { loadSdk: async () => sdk },
    );
    await session.connect();
    expect(hooks.fromConfigSpy).toHaveBeenCalledTimes(1);
    expect(hooks.recognizerCtorSpy).not.toHaveBeenCalled();
    session.close();
  });

  it("rejects connect when the SDK reports a start failure", async () => {
    const { sdk } = createMockSdk({ startsOk: false });
    const session = createAzureSpeechRealtimeTranscriptionSession(baseSessionConfig, {
      loadSdk: async () => sdk,
    });
    await expect(session.connect()).rejects.toThrow(/Azure Speech start failed/);
  });
});

describe("createAzureSpeechRealtimeTranscriptionSession — events", () => {
  it("emits onPartial for recognizing events and onTranscript for recognized events", async () => {
    const { sdk, hooks } = createMockSdk();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, onPartial, onTranscript, onSpeechStart },
      { loadSdk: async () => sdk },
    );
    await session.connect();

    const recognizingEvent: AzureSpeechRecognitionEvent = {
      result: { text: "hello", reason: sdk.ResultReason.RecognizingSpeech },
    };
    hooks.recognizer.recognizing(undefined, recognizingEvent);
    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith("hello");

    const recognizedEvent: AzureSpeechRecognitionEvent = {
      result: { text: "hello world", reason: sdk.ResultReason.RecognizedSpeech },
    };
    hooks.recognizer.recognized(undefined, recognizedEvent);
    expect(onTranscript).toHaveBeenCalledWith("hello world");

    // Repeated identical final transcripts should not emit twice.
    hooks.recognizer.recognized(undefined, recognizedEvent);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("ignores NoMatch recognized events", async () => {
    const { sdk, hooks } = createMockSdk();
    const onTranscript = vi.fn();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, onTranscript },
      { loadSdk: async () => sdk },
    );
    await session.connect();
    hooks.recognizer.recognized(undefined, {
      result: { text: "", reason: sdk.ResultReason.NoMatch },
    });
    expect(onTranscript).not.toHaveBeenCalled();
    session.close();
  });

  it("surfaces canceled events as onError (except EndOfStream)", async () => {
    const { sdk, hooks } = createMockSdk();
    const onError = vi.fn();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, onError },
      { loadSdk: async () => sdk },
    );
    await session.connect();

    // EndOfStream is not an error.
    const endOfStreamEvent: AzureSpeechCancellationEvent = {
      reason: sdk.CancellationReason.EndOfStream,
    };
    hooks.recognizer.canceled(undefined, endOfStreamEvent);
    expect(onError).not.toHaveBeenCalled();

    // Real errors propagate.
    const errorEvent: AzureSpeechCancellationEvent = {
      reason: sdk.CancellationReason.Error,
      errorCode: 4,
      errorDetails: "Authentication failed",
    };
    hooks.recognizer.canceled(undefined, errorEvent);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toContain("Authentication failed");
    expect((onError.mock.calls[0][0] as Error).message).toContain("code 4");
    session.close();
  });
});

describe("createAzureSpeechRealtimeTranscriptionSession — audio & teardown", () => {
  it("forwards audio to the push stream as ArrayBuffer", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(baseSessionConfig, {
      loadSdk: async () => sdk,
    });
    await session.connect();
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    session.sendAudio(buf);
    expect(hooks.pushStream.writeSpy).toHaveBeenCalledTimes(1);
    const sentArg = hooks.pushStream.writeSpy.mock.calls[0][0];
    expect(sentArg).toBeInstanceOf(ArrayBuffer);
    expect((sentArg as ArrayBuffer).byteLength).toBe(5);
    session.close();
  });

  it("triggers onError instead of throwing when audio buffer would overflow", async () => {
    const { sdk } = createMockSdk();
    const onError = vi.fn();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, onError },
      { loadSdk: async () => sdk },
    );
    await session.connect();
    const huge = Buffer.alloc(__testing.AZURE_SPEECH_REALTIME_DEFAULTS.MAX_QUEUED_BYTES + 1);
    session.sendAudio(huge);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain("buffer overflow");
    session.close();
  });

  it("close() stops the recognizer and closes the push stream", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(baseSessionConfig, {
      loadSdk: async () => sdk,
    });
    await session.connect();
    expect(session.isConnected()).toBe(true);
    session.close();
    expect(hooks.stopSpy).toHaveBeenCalled();
    expect(hooks.pushStream.closeSpy).toHaveBeenCalled();
    expect(hooks.closeSpy).toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
  });

  it("close() before connect() still closes the push stream gracefully", async () => {
    const { sdk } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(baseSessionConfig, {
      loadSdk: async () => sdk,
    });
    expect(() => session.close()).not.toThrow();
  });

  it("ignores audio after close()", async () => {
    const { sdk, hooks } = createMockSdk();
    const session = createAzureSpeechRealtimeTranscriptionSession(baseSessionConfig, {
      loadSdk: async () => sdk,
    });
    await session.connect();
    session.close();
    session.sendAudio(Buffer.from([0]));
    expect(hooks.pushStream.writeSpy).not.toHaveBeenCalled();
  });

  it("lazily connects on the first audio frame and delivers the buffered frame after connect resolves", async () => {
    const { sdk, hooks } = createMockSdk();
    const onError = vi.fn();
    const session = createAzureSpeechRealtimeTranscriptionSession(
      { ...baseSessionConfig, onError },
      {
        loadSdk: async () => sdk,
      },
    );
    const buf = Buffer.from([1, 2, 3]);
    session.sendAudio(buf);
    // Allow the lazy connect promise chain to drain.
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(hooks.startSpy).toHaveBeenCalled();
    // The triggering frame must be delivered to the push stream once connect()
    // resolves; it must not be silently dropped or surfaced as an onError.
    expect(hooks.pushStream.writeSpy).toHaveBeenCalledTimes(1);
    const sentArg = hooks.pushStream.writeSpy.mock.calls[0][0] as ArrayBuffer;
    expect(new Uint8Array(sentArg)).toEqual(new Uint8Array(buf));
    expect(onError).not.toHaveBeenCalled();
    session.close();
  });
});
