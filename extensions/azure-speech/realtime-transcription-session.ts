import type {
  PushAudioInputStream,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import {
  createRealtimeVoiceAudioQueue,
  mulawToPcm,
} from "openclaw/plugin-sdk/realtime-voice-provider";

type AzureTranscriptionRequest = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  region: string;
  language: string;
};

const CONNECT_TIMEOUT_MS = 30_000;
// Finish before the Gateway relay releases its five-second final-transcript drain.
const CLOSE_TIMEOUT_MS = 4_500;
const SDK_STOP_TIMEOUT_MS = 250;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;

export function createAzureSpeechTranscriptionSession(
  request: AzureTranscriptionRequest,
): RealtimeTranscriptionSession {
  let state: "idle" | "connecting" | "ready" | "draining" | "closed" = "idle";
  let recognizer: SpeechRecognizer | undefined;
  let input: PushAudioInputStream | undefined;
  let inputClosed = false;
  let receivedAudio = false;
  let connected: ReturnType<typeof createDeferred<void>> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastResultId: string | undefined;
  let errorReported = false;
  const pendingAudio = createRealtimeVoiceAudioQueue("reject-newest", () => {
    fail(new Error("Azure Speech dictation audio queue is full. Stop and try again."));
  });

  function closeInput() {
    if (input && !inputClosed) {
      inputClosed = true;
      input.close();
    }
  }

  function reportError(error: Error) {
    if (!errorReported) {
      errorReported = true;
      request.onError?.(error);
    }
  }

  function dispose() {
    if (state === "closed") {
      return;
    }
    state = "closed";
    clearTimeout(connectTimer);
    clearTimeout(closeTimer);
    pendingAudio.clear();
    closeInput();
    const ownedRecognizer = recognizer;
    recognizer = undefined;
    if (ownedRecognizer) {
      ownedRecognizer.close(undefined, () => {
        reportError(
          new Error("Azure Speech dictation cleanup failed. Try starting dictation again."),
        );
      });
    }
  }

  function fail(error: Error) {
    if (state === "closed") {
      return;
    }
    connected?.reject(error);
    dispose();
    reportError(error);
  }

  function writeAudio(audio: Buffer) {
    const pcm = mulawToPcm(audio);
    // SDK write owns a copy; never pass a Buffer slab's unrelated trailing bytes.
    input?.write(Uint8Array.from(pcm).buffer);
  }

  async function start() {
    const sdk = await import("microsoft-cognitiveservices-speech-sdk");
    if (state === "closed") {
      return;
    }
    const config = sdk.SpeechConfig.fromSubscription(request.apiKey, request.region);
    config.speechRecognitionLanguage = request.language;
    // SDK close otherwise waits indefinitely for turn.end. Its stop timeout
    // disconnects the transport after our graceful final-transcript window.
    config.setProperty(sdk.PropertyId.Recognizer_StopTimeoutMs, String(SDK_STOP_TIMEOUT_MS));
    input = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(8000, 16, 1),
    );
    const audioConfig = sdk.AudioConfig.fromStreamInput(input);
    const currentRecognizer = new sdk.SpeechRecognizer(config, audioConfig);
    recognizer = currentRecognizer;

    currentRecognizer.speechStartDetected = () => {
      if (state === "ready") {
        request.onSpeechStart?.();
      }
    };
    currentRecognizer.recognizing = (_, event) => {
      if (state !== "ready") {
        return;
      }
      if (Buffer.byteLength(event.result.text, "utf8") > MAX_TRANSCRIPT_BYTES) {
        fail(new Error("Azure Speech dictation transcript is too large. Stop and try again."));
        return;
      }
      request.onPartial?.(event.result.text);
    };
    currentRecognizer.recognized = (_, event) => {
      if (state === "closed") {
        return;
      }
      if (event.result.reason === sdk.ResultReason.NoMatch) {
        request.onPartial?.("");
        return;
      }
      if (event.result.reason !== sdk.ResultReason.RecognizedSpeech) {
        return;
      }
      const text = event.result.text.trim();
      if (!text || (event.result.resultId && event.result.resultId === lastResultId)) {
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES) {
        fail(new Error("Azure Speech dictation transcript is too large. Stop and try again."));
        return;
      }
      lastResultId = event.result.resultId;
      request.onTranscript?.(text);
    };
    currentRecognizer.canceled = (_, event) => {
      if (state === "closed") {
        return;
      }
      if (event.reason === sdk.CancellationReason.EndOfStream && state === "draining") {
        dispose();
        return;
      }
      const message =
        event.errorCode === sdk.CancellationErrorCode.AuthenticationFailure
          ? "Azure Speech authentication failed. Check the Speech resource key and region."
          : event.errorCode === sdk.CancellationErrorCode.TooManyRequests ||
              event.errorCode === sdk.CancellationErrorCode.Forbidden
            ? "Azure Speech dictation was refused. Check the resource quota and access, then retry."
            : "Azure Speech dictation was interrupted. Check the connection and recognition language, then retry.";
      // SDK errorDetails can include endpoints and credentials.
      fail(new Error(message));
    };
    currentRecognizer.sessionStopped = () => {
      if (state === "draining") {
        dispose();
      } else if (state !== "closed") {
        fail(new Error("Azure Speech dictation ended unexpectedly. Start dictation again."));
      }
    };
    currentRecognizer.startContinuousRecognitionAsync(
      () => {
        if (state === "closed") {
          return;
        }
        clearTimeout(connectTimer);
        for (const audio of pendingAudio.drain()) {
          writeAudio(audio);
        }
        if (state === "draining") {
          closeInput();
        } else {
          state = "ready";
        }
        connected?.resolve();
      },
      () =>
        fail(
          new Error(
            "Azure Speech dictation could not start. Check the resource key, region, and connection.",
          ),
        ),
    );
  }

  return {
    connect() {
      if (connected) {
        return connected.promise;
      }
      if (state === "closed" || state === "draining") {
        return Promise.reject(new Error("Azure Speech dictation session is closed."));
      }
      state = "connecting";
      connected = createDeferred();
      connectTimer = setTimeout(() => {
        fail(
          new Error("Azure Speech dictation connection timed out. Check connectivity and retry."),
        );
      }, CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      void start().catch(() => {
        fail(
          new Error(
            "Azure Speech dictation initialization failed. Check the plugin installation and Speech configuration.",
          ),
        );
      });
      return connected.promise;
    },
    sendAudio(audio) {
      if (state === "closed" || state === "draining") {
        return;
      }
      receivedAudio ||= audio.byteLength > 0;
      if (state === "ready") {
        writeAudio(audio);
      } else {
        pendingAudio.enqueue(audio);
      }
    },
    close() {
      if (state === "closed" || state === "draining") {
        return;
      }
      if (state === "idle" || (state === "connecting" && !receivedAudio)) {
        connected?.resolve();
        dispose();
        return;
      }
      const ready = state === "ready";
      state = "draining";
      closeTimer = setTimeout(() => {
        fail(
          new Error(
            "Azure Speech dictation did not finish in time. Final words may be missing; retry.",
          ),
        );
      }, CLOSE_TIMEOUT_MS);
      closeTimer.unref?.();
      // Closing the push stream queues EOF after its audio. Calling SDK stop here
      // would turn the audio source off before queued final frames reach Azure.
      if (ready) {
        closeInput();
      }
    },
    isConnected: () => state === "ready",
  };
}
