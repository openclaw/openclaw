// Voice Call module streams a segmented TTS reply over one Twilio media stream.
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { MediaStreamHandler } from "../../media-stream.js";
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

    const synthTimeoutMs = ttsProvider.synthesisTimeoutMs;

    /**
     * Bound one TTS provider step by the synthesis timeout and the playback
     * abort signal, holding the carrier stream open with keep-alive silence
     * while it runs.
     *
     * Every step that reaches the provider needs this bound, not just
     * synthesis. Directive resolution performs async provider and preference
     * lookups, so an unbounded await there would stream keep-alive silence
     * forever and never release this stream's serialized queue slot: the
     * caller would hear endless silence and the turn could never settle.
     */
    const boundedProviderStep = async <T>(step: () => Promise<T>, label: string): Promise<T> => {
      // Hold the stream open across this step's gap; the `finally` stops
      // silence before any speech frame is sent.
      startKeepAlive();
      try {
        return await raceWithTimeout<T, never>(
          step,
          synthTimeoutMs,
          () => {
            throw new Error(`Telephony TTS ${label} timed out after ${synthTimeoutMs}ms`);
          },
          {
            signal,
            onAbort: () => {
              throw signal.reason instanceof Error
                ? signal.reason
                : new Error(`Telephony TTS ${label} aborted`);
            },
          },
        );
      } finally {
        // Speech may start next: silence must stop before the first frame.
        stopKeepAlive();
      }
    };

    // Resolved once below, before any segment is played.
    let plan: TelephonySpeechPlan | undefined;

    /**
     * Synthesize one segment and stream its frames.
     * Returns the delivered byte count, or null when playback was aborted.
     */
    const playSegment = async (segment: string): Promise<number | null> => {
      const prepared = plan;
      if (!prepared) {
        throw new Error("Telephony speech plan not prepared");
      }
      const muLawAudio = await boundedProviderStep(
        () => prepared.synthesizeSegment(segment),
        "synthesis",
      );

      if (muLawAudio.length === 0) {
        throw new Error("Telephony TTS produced no audio");
      }

      let chunkAttempts = 0;
      let nextChunkDueAt = Date.now() + CHUNK_DELAY_MS;
      for (let offset = 0; offset < muLawAudio.length; offset += CHUNK_SIZE) {
        if (signal.aborted) {
          return null;
        }
        chunkAttempts += 1;
        if (!handler.sendAudio(streamSid, muLawAudio.subarray(offset, offset + CHUNK_SIZE))) {
          handler.clearAudio(streamSid);
          throw new Error(
            `Telephony stream playback failed: audio chunk ${chunkAttempts} not delivered`,
          );
        }

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

      return muLawAudio.length;
    };

    // Total audio delivered across every segment, for the single end-of-reply mark.
    let totalAudioBytes = 0;
    // Set once a segment's frames have been accepted, so a later failure
    // knows there is buffered audio to clear.
    let anyAudioBuffered = false;

    try {
      // Resolve the inline TTS directive contract over the complete reply
      // exactly once, then split the resolved spoken text. Splitting after
      // resolution means a long reply can never divide a directive block, and
      // the one resolved override set applies to every segment.
      plan = await boundedProviderStep(() => ttsProvider.prepareSpeech(text), "speech preparation");
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
