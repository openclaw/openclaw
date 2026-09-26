// Voice Call module streams a segmented TTS reply over one Twilio media stream.
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { MediaStreamHandler } from "../../media-stream.js";
import { chunkAudio } from "../../telephony-audio.js";
import type { TelephonySpeechPlan, TelephonyTtsProvider } from "../../telephony-tts.js";

/**
 * Play one reply over a Twilio media stream.
 *
 * The complete reply is prepared once and split into bounded segments that are
 * synthesized and streamed sequentially inside a single serialized queue slot,
 * so the caller hears one continuous answer ending in one completion mark.
 */
export async function playSegmentedTtsViaStream(params: {
  handler: MediaStreamHandler;
  ttsProvider: TelephonyTtsProvider;
  streamSid: string;
  text: string;
  nextMarkName: () => string;
}): Promise<void> {
  const { handler, ttsProvider, streamSid, text, nextMarkName } = params;

  // Stream audio in 20ms chunks (160 bytes at 8kHz mu-law)
  const CHUNK_SIZE = 160;
  const CHUNK_DELAY_MS = 20;
  const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0xff);

  await handler.queueTts(streamSid, async (signal) => {
    // Keep-alive silence holds the carrier stream open while there is no
    // speech to send: before the first synthesis, and across the gap while a
    // later segment synthesizes. It must never run while speech frames are
    // streaming, or silence interleaves with speech and stretches playback.
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const stopKeepAlive = () => {
      if (keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
      }
    };
    const startKeepAlive = () => {
      stopKeepAlive();
      handler.sendAudio(streamSid, SILENCE_CHUNK);
      keepAlive = setInterval(() => {
        if (!signal.aborted) {
          handler.sendAudio(streamSid, SILENCE_CHUNK);
        }
      }, CHUNK_DELAY_MS);
    };

    // Resolved once below, before any segment is played.
    let plan: TelephonySpeechPlan | undefined;

    /**
     * Synthesize one segment and stream its frames.
     * Returns the delivered byte count, or null when playback was aborted.
     */
    const playSegment = async (segment: string): Promise<number | null> => {
      if (!plan) {
        throw new Error("Telephony speech plan not prepared");
      }
      // Hold the stream open across this segment's synthesis gap; the
      // synthesis `finally` below stops it before any speech frame is sent.
      startKeepAlive();
      let muLawAudio: Buffer;
      let synthTimeout: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener = () => {};
      const synthTimeoutMs = ttsProvider.synthesisTimeoutMs;
      try {
        const synthPromise = plan.synthesizeSegment(segment);
        const timeoutPromise = new Promise<Buffer>((_, reject) => {
          synthTimeout = setTimeout(() => {
            reject(new Error(`Telephony TTS synthesis timed out after ${synthTimeoutMs}ms`));
          }, synthTimeoutMs);
        });
        const abortPromise = new Promise<never>((_, reject) => {
          const onAbort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("Telephony TTS synthesis aborted"),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            onAbort();
          }
        });
        muLawAudio = await Promise.race([synthPromise, timeoutPromise, abortPromise]);
      } finally {
        if (synthTimeout) {
          clearTimeout(synthTimeout);
        }
        // Speech starts next: silence must stop before the first frame.
        stopKeepAlive();
        removeAbortListener();
      }

      if (muLawAudio.length === 0) {
        throw new Error("Telephony TTS produced no audio");
      }

      let chunkAttempts = 0;
      let chunkDelivered = 0;
      let nextChunkDueAt = Date.now() + CHUNK_DELAY_MS;
      for (const chunk of chunkAudio(muLawAudio, CHUNK_SIZE)) {
        if (signal.aborted) {
          return null;
        }
        chunkAttempts += 1;
        if (!handler.sendAudio(streamSid, chunk)) {
          handler.clearAudio(streamSid);
          throw new Error(
            `Telephony stream playback failed: audio chunk ${chunkAttempts} not delivered`,
          );
        }
        chunkDelivered += 1;

        // Drift-corrected pacing: schedule against an absolute clock to avoid cumulative delay.
        const waitMs = nextChunkDueAt - Date.now();
        if (waitMs > 0) {
          try {
            await sleepWithAbort(Math.ceil(waitMs), signal);
          } catch (error) {
            if (!signal.aborted) {
              throw error;
            }
            return null;
          }
        }
        nextChunkDueAt += CHUNK_DELAY_MS;
        if (signal.aborted) {
          return null;
        }
      }

      if (chunkAttempts === 0 || chunkDelivered !== chunkAttempts) {
        throw new Error("Telephony stream playback failed: incomplete audio delivery");
      }
      return muLawAudio.length;
    };

    // Total audio delivered across every segment, for the single end-of-reply mark.
    let totalAudioBytes = 0;
    // Set once a segment's frames have been accepted, so a later failure
    // knows there is buffered audio to clear.
    let anyAudioBuffered = false;

    try {
      startKeepAlive();
      // Resolve the inline TTS directive contract over the complete reply
      // exactly once, then split the resolved spoken text. Splitting after
      // resolution means a long reply can never divide a directive block, and
      // the one resolved override set applies to every segment.
      plan = await ttsProvider.prepareSpeech(text);
      const segments = plan.segments;
      if (segments.length === 0) {
        return;
      }
      if (segments.length > 1) {
        // Lengths only: spoken content must never reach the log.
        console.log(
          `[voice-call] Telephony TTS split into ${segments.length} segments [${segments
            .map((segment) => segment.length)
            .join(", ")}] (streamSid=${streamSid})`,
        );
      }

      for (const segment of segments) {
        if (signal.aborted) {
          break;
        }
        const deliveredBytes = await playSegment(segment);
        if (deliveredBytes === null) {
          break;
        }
        totalAudioBytes += deliveredBytes;
        anyAudioBuffered = true;
      }
    } catch (error) {
      // Barge-in is a cancellation, not a failure, and the queue clears its
      // own audio on abort. Any other failure part-way through a multi-segment
      // reply must clear what is already buffered, otherwise the caller hears
      // a truncated answer while the turn reports failure.
      if (!signal.aborted && anyAudioBuffered) {
        handler.clearAudio(streamSid);
      }
      throw error;
    } finally {
      stopKeepAlive();
    }

    if (signal.aborted || totalAudioBytes === 0) {
      return;
    }
    // One mark for the whole reply, after every segment has been delivered.
    const markName = nextMarkName();
    await handler.sendMarkAndWait(streamSid, markName, totalAudioBytes / 8, signal);
  });
}
