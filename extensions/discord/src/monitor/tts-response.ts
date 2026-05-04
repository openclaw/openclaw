/**
 * TTS Response Hook — VC-02
 *
 * When an agent response is triggered by an inbound voice message on one of the
 * configured "voice reply" channels, this module converts the text reply to speech
 * via OpenAI TTS (model: tts-1, voice: onyx) and sends it as a Discord voice message.
 *
 * Long-response policy:
 *   If the response exceeds MAX_TTS_WORDS words we fall back to plain text.
 *   Rationale: TTS latency scales with length, Discord voice messages have no
 *   seek bar, and very long audio clips are a poor UX for conversational replies.
 *   The threshold (500 words) keeps voice replies comfortable to listen to while
 *   still handling typical conversational responses.  Anything longer is sent as
 *   regular text so the user gets the answer without waiting.
 *
 * Fallback contract:
 *   Any error — TTS API, ffmpeg conversion, Discord upload — logs a warning and
 *   returns `{ sentAsVoice: false }` so the caller falls back to plain text.
 *   The response is never silently dropped.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RequestClient } from "@buape/carbon";
import { unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { createDiscordRetryRunner } from "../retry.js";
import {
  ensureOggOpus,
  getVoiceMessageMetadata,
  sendDiscordVoiceMessage,
} from "../voice-message.js";

/** Channels that should receive voice replies when the inbound message was audio. */
export const VOICE_REPLY_CHANNEL_IDS = new Set(["1490438088080490506", "1490437981780312064"]);

/**
 * Maximum word count before falling back to plain text.
 * At ~130 wpm, 500 words ≈ 3.8 minutes — already at the upper edge of comfortable.
 */
const MAX_TTS_WORDS = 500;

/** OpenAI TTS timeout in ms — generous to accommodate long-ish responses. */
const TTS_TIMEOUT_MS = 60_000;

const OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function resolveOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

/**
 * Call the OpenAI TTS API and return the raw MP3 buffer.
 * Self-contained: does not depend on the openai extension package.
 */
async function callOpenAITts(params: {
  text: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetch(`${OPENAI_TTS_BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: params.text,
        voice: "onyx",
        response_format: "mp3",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `OpenAI TTS API error (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

export type TtsReplyResult = { sentAsVoice: true } | { sentAsVoice: false; reason: string };

/**
 * Attempt to deliver `text` as a Discord voice message.
 *
 * Returns `{ sentAsVoice: true }` on success.
 * Returns `{ sentAsVoice: false, reason }` on any failure or when the fallback
 * policy applies (too long, no API key, non-voice channel).
 */
export async function tryDeliverTtsReply(params: {
  text: string;
  channelId: string;
  replyToMessageId: string | undefined;
  rest: RequestClient;
  token: string;
}): Promise<TtsReplyResult> {
  const { text, channelId, replyToMessageId, rest, token } = params;

  // Gate: only for configured voice-reply channels.
  if (!VOICE_REPLY_CHANNEL_IDS.has(channelId)) {
    return { sentAsVoice: false, reason: "channel not in voice-reply list" };
  }

  // Gate: word-count fallback.
  const wordCount = countWords(text);
  if (wordCount > MAX_TTS_WORDS) {
    logVerbose(
      `discord tts-response: response too long (${wordCount} words > ${MAX_TTS_WORDS}), falling back to text`,
    );
    return { sentAsVoice: false, reason: "response exceeds max word count" };
  }

  const apiKey = resolveOpenAIApiKey();
  if (!apiKey) {
    logVerbose("discord tts-response: OPENAI_API_KEY not set, falling back to text");
    return { sentAsVoice: false, reason: "OPENAI_API_KEY not configured" };
  }

  let mp3Path: string | null = null;
  let oggPath: string | null = null;
  let oggCleanup = false;

  try {
    // 1. Call OpenAI TTS → MP3 buffer.
    logVerbose(`discord tts-response: synthesising ${wordCount} words via tts-1/onyx`);
    const mp3Buffer = await callOpenAITts({ text, apiKey, timeoutMs: TTS_TIMEOUT_MS });

    // 2. Write MP3 to a temp file so ffmpeg can consume it.
    const tempDir = resolvePreferredOpenClawTmpDir();
    mp3Path = path.join(tempDir, `tts-${crypto.randomUUID()}.mp3`);
    await fs.writeFile(mp3Path, mp3Buffer, { mode: 0o600 });

    // 3. Convert MP3 → OGG/Opus at 48 kHz (Discord voice message requirement).
    const ogg = await ensureOggOpus(mp3Path);
    oggPath = ogg.path;
    oggCleanup = ogg.cleanup;

    // 4. Gather waveform + duration metadata.
    const metadata = await getVoiceMessageMetadata(oggPath);

    // 5. Read OGG bytes.
    const audioBuffer = await fs.readFile(oggPath);

    // 6. Build a retry runner for the upload calls.
    const request = createDiscordRetryRunner({});

    // 7. Send the Discord voice message.
    await sendDiscordVoiceMessage(
      rest,
      channelId,
      audioBuffer,
      metadata,
      replyToMessageId,
      request,
      /* silent */ false,
      token,
    );

    logVerbose(`discord tts-response: voice reply sent to channel ${channelId}`);
    return { sentAsVoice: true };
  } catch (err) {
    logVerbose(`discord tts-response: failed, falling back to text: ${String(err)}`);
    return { sentAsVoice: false, reason: String(err) };
  } finally {
    // Best-effort temp file cleanup.
    await unlinkIfExists(mp3Path).catch(() => undefined);
    if (oggCleanup) {
      await unlinkIfExists(oggPath).catch(() => undefined);
    }
  }
}
