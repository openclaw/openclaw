/**
 * Kokoro TTS wrapper — generates natural speech audio locally.
 * Falls back to edge-tts if Kokoro fails.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SlideContent, AudioSegment, PipelineConfig } from "../types.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "..", "scripts");

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function generateWithKokoro(
  text: string,
  outputPath: string,
  voice: string,
  speed: number,
): Promise<number> {
  const textFile = outputPath.replace(/\.wav$/, ".txt");
  await writeFile(textFile, text);

  const { stdout } = await execAsync(
    `${platform === "win32" ? "python" : "python3"} "${join(SCRIPTS_DIR, "kokoro-generate.py")}" --file "${textFile}" --voice "${voice}" --speed ${speed} --output "${outputPath}"`,
    { timeout: 60_000 },
  );

  // Parse duration from stdout
  const match = stdout.match(/duration:([\d.]+)/);
  return match ? parseFloat(match[1]) : await getAudioDuration(outputPath);
}

async function generateWithEdgeTts(
  text: string,
  audioPath: string,
  voice: string,
): Promise<{ duration: number; srtPath: string }> {
  const srtPath = audioPath.replace(/\.(wav|mp3)$/, ".srt");
  const textFile = audioPath.replace(/\.(wav|mp3)$/, ".txt");
  await writeFile(textFile, text);

  // edge-tts outputs mp3, so use mp3 path
  const mp3Path = audioPath.replace(/\.wav$/, ".mp3");
  await execAsync(
    `edge-tts --voice "${voice}" --file "${textFile}" --write-media "${mp3Path}" --write-subtitles "${srtPath}"`,
  );

  const duration = await getAudioDuration(mp3Path);
  return { duration, srtPath };
}

export async function generateTtsAudio(
  slides: SlideContent[],
  outputDir: string,
  config: PipelineConfig["video"],
): Promise<AudioSegment[]> {
  const ttsEngine = ((config as Record<string, unknown>).ttsEngine as string) ?? "kokoro";
  const voice = config.ttsVoice ?? "af_heart";
  const speed = ((config as Record<string, unknown>).ttsSpeed as number) ?? 1.0;
  const edgeTtsVoice = config.ttsVoice ?? "en-US-AndrewNeural";

  const audioDir = join(outputDir, "audio");
  await mkdir(audioDir, { recursive: true });

  const useKokoro =
    ttsEngine === "kokoro" &&
    existsSync(join(homedir(), ".openclaw", "models", "kokoro-v1.0.onnx"));

  console.log(`🎙️ TTS engine: ${useKokoro ? "Kokoro (local)" : "edge-tts (cloud)"}`);

  const segments: AudioSegment[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const idx = String(i + 1).padStart(2, "0");
    const audioPath = join(audioDir, `slide_${idx}.wav`);
    const srtPath = join(audioDir, `slide_${idx}.srt`);

    if (!slide.speakerNotes?.trim()) {
      // Generate silence
      await execAsync(
        `ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${config.durationPerSlide} -q:a 9 "${audioPath}"`,
      );
      await writeFile(srtPath, "");
      segments.push({ audioPath, srtPath, durationSeconds: config.durationPerSlide });
      continue;
    }

    try {
      if (useKokoro) {
        const duration = await generateWithKokoro(slide.speakerNotes, audioPath, voice, speed);
        await writeFile(srtPath, ""); // Kokoro doesn't generate SRT
        segments.push({ audioPath, srtPath, durationSeconds: duration });
      } else {
        const mp3Path = join(audioDir, `slide_${idx}.mp3`);
        const result = await generateWithEdgeTts(slide.speakerNotes, mp3Path, edgeTtsVoice);
        // Convert mp3 to wav for Remotion
        await execAsync(`ffmpeg -y -i "${mp3Path}" "${audioPath}"`);
        segments.push({ audioPath, srtPath: result.srtPath, durationSeconds: result.duration });
      }
    } catch (err) {
      console.error(`  ✗ TTS failed for slide ${i + 1}: ${(err as Error).message}`);
      // Fallback: generate silence
      await execAsync(
        `ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${config.durationPerSlide} -q:a 9 "${audioPath}"`,
      );
      await writeFile(srtPath, "");
      segments.push({ audioPath, srtPath, durationSeconds: config.durationPerSlide });
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  console.log(
    `  ✓ ${segments.length} audio segments (total: ${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s)`,
  );

  return segments;
}

/** Concatenate all audio segments into a single WAV file */
export async function concatenateAudio(
  segments: AudioSegment[],
  outputPath: string,
): Promise<void> {
  const listFile = outputPath.replace(/\.wav$/, "-list.txt");
  const lines = segments.map((s) => `file '${s.audioPath.replace(/\\/g, "/")}'`).join("\n");
  await writeFile(listFile, lines);
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`);
}
