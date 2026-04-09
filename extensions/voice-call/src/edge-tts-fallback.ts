/**
 * Edge TTS fallback for telephony — zero-cost backup when Cartesia is down.
 * Generates WAV audio via Microsoft Edge TTS (free, no API key needed).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Dynamic import to avoid hard dependency on node-edge-tts
let EdgeTTSClass: any = null;

async function getEdgeTTS(): Promise<any> {
  if (!EdgeTTSClass) {
    const mod = await import("node-edge-tts");
    EdgeTTSClass = mod.EdgeTTS;
  }
  return EdgeTTSClass;
}

/**
 * Generate MP3 audio using Edge TTS.
 * Returns a Buffer containing MP3 audio ready for Telnyx playback_start.
 */
export async function edgeTtsFallback(
  text: string,
  voice = "en-US-AvaNeural",
  timeoutMs = 10000,
): Promise<{ audio: Buffer; format: "mp3" }> {
  const EdgeTTS = await getEdgeTTS();

  // Use MP3 format — WAV times out with Edge TTS, MP3 works fast (~600ms)
  const tts = new EdgeTTS({
    voice,
    lang: "en-US",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    rate: "+10%",
    timeout: timeoutMs,
  });

  // Edge TTS writes to file — use a temp file
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

  try {
    await tts.ttsPromise(text, tmpFile);
    const mp3 = fs.readFileSync(tmpFile);
    return { audio: mp3, format: "mp3" as const };
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
