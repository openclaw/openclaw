/**
 * Whisper STT via external HTTP service or local CLI.
 *
 * Extracted from extensions/feishu/src/bot.ts on the dev branch.
 * Two modes:
 *   1. Remote: POST audio_base64 to OPENCLAW_WHISPER_URL
 *   2. Local:  Shell out to python3 whisper_stt.py <audioPath>
 */
import { readFile } from "node:fs/promises";

export type WhisperSttOptions = {
  /** Path to the local audio file to transcribe */
  audioPath: string;
  /** Optional Whisper HTTP service URL. Falls back to OPENCLAW_WHISPER_URL env. */
  whisperUrl?: string;
  /** Path to local whisper_stt.py script. Falls back to OPENCLAW_WHISPER_SCRIPT env. */
  whisperScript?: string;
  /** HTTP request timeout in ms (default 30_000) */
  timeoutMs?: number;
  /** Optional log callback */
  log?: (msg: string) => void;
};

/**
 * Attempt audio transcription via Whisper (remote HTTP or local CLI).
 *
 * Returns undefined on any failure — callers should fall back gracefully.
 */
export async function recognizeAudioWithWhisper(opts: WhisperSttOptions): Promise<string | undefined> {
  const { audioPath, log, timeoutMs = 30_000 } = opts;
  const whisperUrl = opts.whisperUrl || process.env.OPENCLAW_WHISPER_URL;

  // ---- Remote HTTP service ----
  if (whisperUrl) {
    try {
      const audioBuf = await readFile(audioPath);
      const b64 = audioBuf.toString("base64");
      log?.(`feishu: Whisper STT (remote) attempting for ${audioPath}`);
      const res = await fetch(whisperUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_base64: b64 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      const text = data?.text?.trim();
      if (!text) {
        log?.(`feishu: Whisper STT (remote) returned empty`);
        return undefined;
      }
      log?.(`feishu: Whisper STT (remote) success: ${text.slice(0, 80)}`);
      return text;
    } catch (err) {
      log?.(`feishu: Whisper STT (remote) failed: ${String(err)}`);
      return undefined;
    }
  }

  // ---- Local CLI fallback ----
  try {
    log?.(`feishu: Whisper STT (local) attempting for ${audioPath}`);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const scriptPath =
      opts.whisperScript ||
      process.env.OPENCLAW_WHISPER_SCRIPT ||
      "/root/.openclaw/workspace/scripts/whisper_stt.py";
    const { stdout } = await execFileAsync("python3", [scriptPath, audioPath], {
      timeout: 60_000,
    });
    const data = JSON.parse(stdout.trim()) as { text?: string };
    const text = data?.text?.trim();
    if (!text) {
      log?.(`feishu: Whisper STT (local) returned empty`);
      return undefined;
    }
    log?.(`feishu: Whisper STT (local) success: ${text.slice(0, 80)}`);
    return text;
  } catch (err) {
    log?.(`feishu: Whisper STT (local) failed: ${String(err)}`);
    return undefined;
  }
}
