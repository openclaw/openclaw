/**
 * TTS engine adapters — Kokoro (local) and edge-tts (cloud).
 *
 * Both adapters follow the same contract: take text + output path + voice
 * options, return the resulting audio path and duration. Both throw on
 * failure so the caller can decide to retry with the other engine or fall
 * back to silence.
 */
import { exec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { platform } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface TtsEngineResult {
  /** The output .wav file path (guaranteed to exist on success) */
  audioPath: string;
  /** Duration in seconds */
  durationSeconds: number;
}

export interface KokoroOpts {
  voice: string;
  speed: number;
  /** Path to the Kokoro Python generator script */
  scriptPath: string;
}

export interface EdgeTtsOpts {
  voice: string;
}

async function ffprobeDuration(path: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${path}"`,
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Generate TTS audio with Kokoro (local onnx model).
 *
 * Writes `text` to a temporary .txt file next to `outputPath`, then runs the
 * Python runner at `opts.scriptPath`. The Python script parses `duration:N`
 * from stdout on success — we fall back to ffprobe if that's missing.
 */
export async function kokoroTts(
  text: string,
  outputPath: string,
  opts: KokoroOpts,
): Promise<TtsEngineResult> {
  const textFile = outputPath.replace(/\.wav$/, ".txt");
  await writeFile(textFile, text);

  const python = platform === "win32" ? "python" : "python3";
  const cmd = `${python} "${opts.scriptPath}" --file "${textFile}" --voice "${opts.voice}" --speed ${opts.speed} --output "${outputPath}"`;

  const { stdout } = await execAsync(cmd, { timeout: 120_000 });

  const match = stdout.match(/duration:([\d.]+)/);
  const durationSeconds = match ? parseFloat(match[1]) : await ffprobeDuration(outputPath);

  return { audioPath: outputPath, durationSeconds };
}

/**
 * Generate TTS audio with edge-tts (Microsoft Edge cloud TTS CLI).
 *
 * Outputs MP3 first (edge-tts doesn't support WAV directly), then normalizes
 * to WAV so downstream Remotion / ffmpeg concat work uniformly across engines.
 */
export async function edgeTtsAdapter(
  text: string,
  outputPath: string,
  opts: EdgeTtsOpts,
): Promise<TtsEngineResult> {
  const textFile = outputPath.replace(/\.wav$/, ".txt");
  const mp3Path = outputPath.replace(/\.wav$/, ".mp3");
  await writeFile(textFile, text);

  const cmd = `edge-tts --voice "${opts.voice}" --file "${textFile}" --write-media "${mp3Path}"`;
  await execAsync(cmd, { timeout: 60_000 });

  // Normalize to WAV so the rest of the pipeline doesn't care about codec
  await execAsync(`ffmpeg -y -i "${mp3Path}" "${outputPath}"`, { timeout: 30_000 });

  const durationSeconds = await ffprobeDuration(outputPath);
  return { audioPath: outputPath, durationSeconds };
}
