import {
  type RealtimeTranscriptionSession,
  type RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  AzureSpeechPushStream,
  AzureSpeechRealtimeSdk,
  AzureSpeechSpeechRecognizer,
} from "./realtime-transcription-types.js";

/**
 * Audio encodings supported by the Azure Speech realtime transcription bridge.
 *
 * - `pcm`: 16-bit signed little-endian PCM (default for the Speech SDK).
 * - `mulaw`: 8-bit G.711 µ-law (telephony / Twilio media stream default).
 * - `alaw`: 8-bit G.711 A-law (European telephony).
 */
export type AzureSpeechRealtimeEncoding = "pcm" | "mulaw" | "alaw";

export type AzureSpeechRealtimeSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  region?: string;
  endpoint?: string;
  language: string;
  sampleRate: number;
  encoding: AzureSpeechRealtimeEncoding;
  initialSilenceTimeoutMs: number;
  endSilenceTimeoutMs: number;
  candidateLanguages?: string[];
};

export type AzureSpeechRealtimeDeps = {
  loadSdk: () => Promise<AzureSpeechRealtimeSdk>;
};

export const AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

export function audioFormatTagFor(
  encoding: AzureSpeechRealtimeEncoding,
  sdk: AzureSpeechRealtimeSdk,
): number {
  switch (encoding) {
    case "pcm":
      return sdk.AudioFormatTag.PCM;
    case "mulaw":
      return sdk.AudioFormatTag.MuLaw;
    case "alaw":
      return sdk.AudioFormatTag.ALaw;
    /* istanbul ignore next */
    default: {
      const exhaustive: never = encoding;
      throw new Error(`Unsupported Azure Speech realtime encoding: ${String(exhaustive)}`);
    }
  }
}

export function bitsPerSampleFor(encoding: AzureSpeechRealtimeEncoding): number {
  return encoding === "pcm" ? 16 : 8;
}

export function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  // Buffer.buffer is typed as ArrayBufferLike; coerce to a plain ArrayBuffer
  // because the Speech SDK push stream signature requires ArrayBuffer.
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer as ArrayBuffer;
  }
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function requireRegionFor(config: AzureSpeechRealtimeSessionConfig): string {
  if (config.region) {
    return config.region;
  }
  throw new Error(
    "Azure Speech realtime transcription requires either an explicit endpoint or a region",
  );
}

export function createAzureSpeechRealtimeTranscriptionSession(
  config: AzureSpeechRealtimeSessionConfig,
  deps: AzureSpeechRealtimeDeps,
): RealtimeTranscriptionSession {
  let recognizer: AzureSpeechSpeechRecognizer | undefined;
  let pushStream: AzureSpeechPushStream | undefined;
  let connected = false;
  let connecting: Promise<void> | undefined;
  let closing = false;
  let speechStarted = false;
  let queuedBytes = 0;
  let lastFinalTranscript: string | undefined;
  // Audio frames received before connect() resolves are buffered here and
  // flushed once the push stream is ready, so the first lazy-connect frame is
  // not silently dropped. Capped by AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES.
  const pendingAudio: Buffer[] = [];
  let pendingAudioBytes = 0;

  const handleError = (error: Error) => {
    config.onError?.(error);
  };

  const closeStreamAndRecognizer = () => {
    try {
      pushStream?.close();
    } catch {
      /* ignore */
    }
    try {
      recognizer?.close();
    } catch {
      /* ignore */
    }
  };

  const teardown = () => {
    if (closing) {
      return;
    }
    closing = true;
    connected = false;
    if (recognizer) {
      try {
        recognizer.stopContinuousRecognitionAsync(closeStreamAndRecognizer, (msg) => {
          handleError(new Error(`Azure Speech stop failed: ${msg}`));
          closeStreamAndRecognizer();
        });
      } catch (error) {
        handleError(error instanceof Error ? error : new Error(String(error)));
      }
    } else {
      try {
        pushStream?.close();
      } catch {
        /* ignore */
      }
    }
  };

  const wireRecognizerEvents = (sdk: AzureSpeechRealtimeSdk) => {
    if (!recognizer) {
      return;
    }
    recognizer.recognizing = (_sender, event) => {
      const text = normalizeOptionalString(event.result?.text);
      if (!text) {
        return;
      }
      if (!speechStarted) {
        speechStarted = true;
        config.onSpeechStart?.();
      }
      config.onPartial?.(text);
    };

    recognizer.recognized = (_sender, event) => {
      if (event.result?.reason === sdk.ResultReason.NoMatch) {
        speechStarted = false;
        return;
      }
      const text = normalizeOptionalString(event.result?.text);
      if (!text) {
        speechStarted = false;
        return;
      }
      if (text === lastFinalTranscript) {
        speechStarted = false;
        return;
      }
      lastFinalTranscript = text;
      speechStarted = false;
      config.onTranscript?.(text);
    };

    recognizer.canceled = (_sender, event) => {
      if (event.reason === sdk.CancellationReason.EndOfStream) {
        return;
      }
      const detail = normalizeOptionalString(event.errorDetails);
      const code = event.errorCode != null ? ` (code ${event.errorCode})` : "";
      handleError(new Error(`Azure Speech recognizer canceled${code}: ${detail ?? "unknown"}`));
    };

    recognizer.speechStartDetected = () => {
      if (!speechStarted) {
        speechStarted = true;
        config.onSpeechStart?.();
      }
    };

    recognizer.sessionStopped = () => {
      speechStarted = false;
    };
  };

  const connect = async (): Promise<void> => {
    if (connected) {
      return;
    }
    if (connecting) {
      return connecting;
    }
    connecting = (async () => {
      const sdk = await deps.loadSdk();
      const speechConfig = config.endpoint
        ? sdk.SpeechConfig.fromEndpoint(new URL(config.endpoint), config.apiKey)
        : sdk.SpeechConfig.fromSubscription(config.apiKey, requireRegionFor(config));
      speechConfig.speechRecognitionLanguage = config.language;
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
        String(config.initialSilenceTimeoutMs),
      );
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
        String(config.endSilenceTimeoutMs),
      );
      const format = sdk.AudioStreamFormat.getWaveFormat(
        config.sampleRate,
        bitsPerSampleFor(config.encoding),
        1,
        audioFormatTagFor(config.encoding, sdk),
      );
      pushStream = sdk.AudioInputStream.createPushStream(format);
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

      if (config.candidateLanguages && config.candidateLanguages.length > 0) {
        const autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(
          config.candidateLanguages,
        );
        recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig);
      } else {
        recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      }

      wireRecognizerEvents(sdk);

      await new Promise<void>((resolve, reject) => {
        recognizer?.startContinuousRecognitionAsync(
          () => resolve(),
          (msg) => reject(new Error(`Azure Speech start failed: ${msg}`)),
        );
      });
      connected = true;
      flushPendingAudio();
    })();
    try {
      await connecting;
    } finally {
      connecting = undefined;
    }
  };

  const sendAudio = (audio: Buffer): void => {
    if (closing) {
      return;
    }
    if (!pushStream) {
      // Should not happen if connect() resolved first; surface as error.
      handleError(new Error("Azure Speech push stream is not initialized"));
      return;
    }
    if (queuedBytes + audio.byteLength > AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES) {
      handleError(
        new Error(
          `Azure Speech audio buffer overflow: queued ${queuedBytes + audio.byteLength} bytes exceeds ${AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES}`,
        ),
      );
      return;
    }
    queuedBytes += audio.byteLength;
    try {
      pushStream.write(bufferToArrayBuffer(audio));
    } finally {
      // The SDK ingests synchronously; release the budget on the next tick to allow brief bursts.
      queueMicrotask(() => {
        queuedBytes = Math.max(0, queuedBytes - audio.byteLength);
      });
    }
  };

  const flushPendingAudio = (): void => {
    while (pendingAudio.length > 0) {
      if (closing || !pushStream) {
        break;
      }
      const next = pendingAudio.shift();
      if (!next) {
        break;
      }
      pendingAudioBytes = Math.max(0, pendingAudioBytes - next.byteLength);
      sendAudio(next);
    }
  };

  return {
    async connect() {
      await connect();
    },
    sendAudio(audio: Buffer) {
      if (closing) {
        return;
      }
      if (!connected) {
        // Buffer the frame until connect() resolves so the triggering frame is
        // not lost on lazy connect (push stream is not initialized yet).
        if (
          queuedBytes + pendingAudioBytes + audio.byteLength >
          AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES
        ) {
          handleError(
            new Error(
              `Azure Speech audio buffer overflow: queued ${
                queuedBytes + pendingAudioBytes + audio.byteLength
              } bytes exceeds ${AZURE_SPEECH_REALTIME_MAX_QUEUED_BYTES}`,
            ),
          );
          return;
        }
        pendingAudio.push(audio);
        pendingAudioBytes += audio.byteLength;
        if (!connecting) {
          // Lazy connect on first audio frame for parity with sibling providers.
          connect().catch((error) =>
            handleError(error instanceof Error ? error : new Error(String(error))),
          );
        }
        return;
      }
      sendAudio(audio);
    },
    close() {
      teardown();
    },
    isConnected() {
      return connected && !closing;
    },
  };
}
