// Pre-dispatch transcript enricher for inbound BlueBubbles audio messages.
//
// BlueBubbles v1.14.0+ exposes `GET /api/v1/message/audio-transcript/:guid`
// which returns Apple's free on-device dictation transcript for a voice note.
// Without this enricher, the agent receives `<media:audio> (1 audio)` (or the
// raw `🎤 [Audio]` placeholder) and has no idea what the user said.
//
// The enricher runs after access gating but before envelope formatting and
// agent dispatch. When it finds an audio attachment, it asks BB Server for the
// transcript and — if one is available — substitutes it for the placeholder
// body. Older BB Servers reply 404, in which case the call returns null and
// we fall through to the existing placeholder behavior. (#68719)

import type { BlueBubblesClient } from "./client.js";
import { isBlueBubblesAudioAttachment } from "./monitor-normalize.js";
import type { BlueBubblesAccountConfig, BlueBubblesAttachment } from "./types.js";

const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 8_000;

export type InboundAudioEnricherConfig = {
  /** Default true. Set false to keep the placeholder body. */
  enabled?: boolean;
  /** Per-attachment-type opt-outs. Reserved for future media types; only `audio` is honored today. */
  perType?: {
    audio?: boolean;
  };
};

export function isInboundAudioEnricherEnabled(account: BlueBubblesAccountConfig): boolean {
  const cfg = account.inboundAudioEnricher;
  if (cfg?.enabled === false) {
    return false;
  }
  if (cfg?.perType?.audio === false) {
    return false;
  }
  return true;
}

/**
 * Returns the audio attachment to transcribe, or undefined when the message
 * is not a candidate. To avoid masking non-audio cues (a photo sent alongside
 * a voice note), the enricher only replaces the body when EVERY attachment is
 * audio. Mixed messages keep their existing `<media:attachment>` placeholder
 * and rely on the downstream media-understanding pass to handle each modality.
 */
export function selectAudioAttachmentForTranscript(
  attachments: BlueBubblesAttachment[],
): BlueBubblesAttachment | undefined {
  if (attachments.length === 0) {
    return undefined;
  }
  if (!attachments.every(isBlueBubblesAudioAttachment)) {
    return undefined;
  }
  return attachments.find((entry) => entry.guid && isBlueBubblesAudioAttachment(entry));
}

export type EnrichInboundAudioParams = {
  client: BlueBubblesClient;
  /** BlueBubbles message guid; `audio-transcript/:guid` keys on the message, not the attachment. */
  messageGuid: string | undefined;
  attachments: BlueBubblesAttachment[];
  /** Existing user-typed text on the message; only enrich when this is empty (pre-trimmed; we re-trim defensively). */
  existingText: string;
  account: BlueBubblesAccountConfig;
  timeoutMs?: number;
};

/**
 * Outcome of running the enricher against an inbound message. The shape is
 * deliberately verbose (rather than just `string | null`) so the call site can
 * emit a precise verbose log without re-deriving why nothing happened.
 *
 *   - `applied`     : transcript was fetched and should replace the body.
 *   - `no-audio`    : no audio attachment matched the all-audio gate (mixed or non-audio).
 *   - `no-transcript`: audio was present but BB returned nothing (older BB, empty body, transient error).
 *   - `disabled`    : enricher is off via config.
 *   - `skipped`     : caller-precondition failed (existing text, missing creds, no message guid).
 */
export type InboundAudioEnrichmentOutcome =
  | { reason: "applied"; transcript: string }
  | { reason: "no-audio" }
  | { reason: "no-transcript" }
  | { reason: "disabled" }
  | { reason: "skipped" };

/**
 * Run the enricher against an inbound BlueBubbles message and report what
 * happened. The structured outcome lets the call site distinguish "no audio
 * here" from "audio here but no transcript" so verbose logging can be precise.
 *
 * Never throws — transcript fetching is best-effort and must not break the
 * inbound path.
 */
export async function enrichInboundAudioMessage(
  params: EnrichInboundAudioParams,
): Promise<InboundAudioEnrichmentOutcome> {
  if (!isInboundAudioEnricherEnabled(params.account)) {
    return { reason: "disabled" };
  }
  if (params.existingText.trim().length > 0) {
    // The user typed text alongside the audio. Don't replace their words with a transcript.
    return { reason: "skipped" };
  }
  const guid = params.messageGuid?.trim();
  if (!guid) {
    return { reason: "skipped" };
  }
  if (!selectAudioAttachmentForTranscript(params.attachments)) {
    return { reason: "no-audio" };
  }
  let transcript: string | null;
  try {
    transcript = await params.client.getAudioTranscript({
      messageGuid: guid,
      timeoutMs: params.timeoutMs ?? DEFAULT_TRANSCRIPT_TIMEOUT_MS,
    });
  } catch {
    transcript = null;
  }
  if (!transcript) {
    return { reason: "no-transcript" };
  }
  return { reason: "applied", transcript };
}

/**
 * Backwards-compatible thin wrapper used by tests written against the older
 * `string | null` shape. Prefer `enrichInboundAudioMessage` for new callers
 * since it carries the structured outcome.
 */
export async function enrichInboundAudioTranscript(
  params: EnrichInboundAudioParams,
): Promise<string | null> {
  const outcome = await enrichInboundAudioMessage(params);
  return outcome.reason === "applied" ? outcome.transcript : null;
}
