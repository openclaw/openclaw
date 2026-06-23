import { setTimeout as sleep } from "node:timers/promises";
import { inferEmotion } from "./expression.js";
import {
  MSTEAMS_PCM_SAMPLE_RATE_HZ,
  type MsteamsLogger,
  type MsteamsSession,
} from "./msteams-media-stream.js";
import type { MsteamsTtsProvider } from "./msteams-tts.js";
import { chunkAudio } from "./telephony-audio.js";
import { estimateVisemes, visemesFromAlignment } from "./viseme-estimate.js";

/** PCM 16 kHz, 16-bit mono — the wire format both directions of the Teams bridge. */
const MSTEAMS_SAMPLE_RATE_HZ = MSTEAMS_PCM_SAMPLE_RATE_HZ;
const FRAME_DURATION_MS = 20;
const BYTES_PER_SAMPLE = 2;
/** 16000 Hz * 0.02 s * 2 bytes = 640 bytes per 20 ms mono frame. */
const FRAME_BYTES = (MSTEAMS_SAMPLE_RATE_HZ / 1000) * FRAME_DURATION_MS * BYTES_PER_SAMPLE;

/** The per-call fields TTS playback reads/advances (a structural subset of the provider's call state). */
export interface TtsPlaybackTarget {
  providerCallId: string;
  session: MsteamsSession;
  /** Aborts the in-flight playback (barge-in / hangup). */
  ttsAbort: AbortController | null;
  /** Current assistant turn id (used for assistant.cancel on barge-in). */
  turnId: number;
  /** Monotonic outbound audio.frame sequence number / presentation timestamp for this call. */
  outboundSeq: number;
  outboundTimestampMs: number;
  /** Wall-clock (ms) of the last audio.frame we sent — drives the streaming half-duplex echo guard. */
  lastOutboundFrameAt: number;
}

export interface TtsPlaybackDeps {
  ttsProvider: MsteamsTtsProvider;
  logger?: MsteamsLogger;
}

/**
 * Synthesize `text` and stream it to the worker as 20 ms / 640-byte PCM frames, cueing the avatar's
 * emotion and viseme timeline just ahead of the audio. Supersedes any in-flight playback for the call
 * (barge-in), and throws if the worker socket closes mid-playback so the caller (manager.speak)
 * finalizes the turn instead of advancing seq/timestamps and reporting the audio as delivered.
 */
export async function playTtsToCall(
  deps: TtsPlaybackDeps,
  state: TtsPlaybackTarget,
  text: string,
): Promise<void> {
  // Supersede any in-flight playback for this call (e.g. rapid responses).
  state.ttsAbort?.abort();
  const abort = new AbortController();
  state.ttsAbort = abort;
  state.turnId += 1;

  // CVI Phase 6b: cue the avatar's emotion from the reply text before audio starts, so the face
  // shapes its mouth (smile/frown/surprise) as it begins talking. Best-effort — the worker ignores
  // an unknown tag, and a failed send must never block playback.
  try {
    const emotion = inferEmotion(text);
    deps.logger?.debug?.(
      `MsteamsProvider: expression cue '${emotion}' for ${state.providerCallId}`,
    );
    state.session.send({ type: "expression", emotion });
  } catch {
    // non-fatal: expression is a cosmetic cue
  }

  // msteams-tts.ts synthesizes and resamples to PCM 16 kHz mono. Prefer the timing-aware path
  // so providers that return character alignment (ElevenLabs with-timestamps) drive real viseme
  // timing; providers without it return audio-only and we estimate below.
  const synthesis = deps.ttsProvider.synthesizePcm16kWithTiming
    ? await deps.ttsProvider.synthesizePcm16kWithTiming(text)
    : { pcm16k: await deps.ttsProvider.synthesizePcm16k(text) };
  const pcm16k = synthesis.pcm16k;
  if (abort.signal.aborted) {
    return;
  }
  if (pcm16k.length === 0) {
    throw new Error("MsteamsProvider.playTts: TTS produced no audio");
  }

  // CVI Phase 5: send a viseme timeline just ahead of the audio. Real per-character timing from
  // the provider's alignment when available; otherwise an even-spread estimate from the text and
  // audio duration. A viseme-capable worker layers these as coarse mouth shapes
  // (open/wide/round/closed) over its RMS-driven openness; an older worker ignores the message and
  // stays RMS-only. Best-effort/cosmetic either way.
  try {
    const alignment = synthesis.alignment;
    let marks = alignment
      ? visemesFromAlignment(alignment.characters, alignment.startTimesSeconds)
      : [];
    if (marks.length === 0) {
      const durationMs = (pcm16k.length / BYTES_PER_SAMPLE / MSTEAMS_SAMPLE_RATE_HZ) * 1000;
      marks = estimateVisemes(text, durationMs);
    }
    if (marks.length > 0) {
      deps.logger?.debug?.(
        `MsteamsProvider: speech.marks ${marks.length} visemes (${alignment ? "aligned" : "estimated"}) for ${state.providerCallId}`,
      );
      state.session.send({ type: "speech.marks", ts: 0, marks });
    }
  } catch {
    // non-fatal: viseme marks are a cosmetic lip-shape hint
  }

  await streamPcmFrames(deps, state, pcm16k, abort.signal);

  if (state.ttsAbort === abort) {
    state.ttsAbort = null;
  }
}

/**
 * Chunk PCM into 20 ms / 640-byte frames and send them to the worker with drift-corrected pacing,
 * mirroring Twilio's `playTtsViaStream`. Uses an absolute clock so cumulative scheduling jitter does
 * not accumulate.
 */
async function streamPcmFrames(
  deps: TtsPlaybackDeps,
  state: TtsPlaybackTarget,
  pcm: Buffer,
  signal: AbortSignal,
): Promise<void> {
  let nextFrameDueAt = Date.now() + FRAME_DURATION_MS;
  for (const frame of chunkAudio(pcm, FRAME_BYTES)) {
    if (signal.aborted) {
      return;
    }
    // The worker socket can close mid-playback (caller hangs up between frames). `session.send`
    // drops the frame silently and returns false rather than throwing, so make the failure visible:
    // abort playback so playTts/speak finalize the turn instead of advancing seq/timestamps and
    // reporting the audio as delivered on a dead socket.
    const delivered = state.session.send({
      type: "audio.frame",
      seq: state.outboundSeq,
      timestampMs: state.outboundTimestampMs,
      payloadBase64: frame.toString("base64"),
    });
    if (!delivered) {
      deps.logger?.warn(
        `MsteamsProvider: audio.frame dropped for ${state.providerCallId} — Teams socket closed; aborting playback`,
      );
      throw new Error(
        `msteams audio send failed for ${state.providerCallId}: session socket closed`,
      );
    }
    state.outboundSeq += 1;
    state.outboundTimestampMs += FRAME_DURATION_MS;
    state.lastOutboundFrameAt = Date.now();

    const waitMs = nextFrameDueAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    nextFrameDueAt += FRAME_DURATION_MS;
  }
}
