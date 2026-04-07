import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SlideContent, AudioSegment, PipelineConfig } from "../types.js";

const execAsync = promisify(exec);

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

export async function generateTts(
  slides: SlideContent[],
  outputDir: string,
  config: PipelineConfig["video"],
): Promise<AudioSegment[]> {
  console.log("🎙️ Stage 4a: Generating TTS audio...");

  const audioDir = join(outputDir, "audio");
  const subsDir = join(outputDir, "subs");
  await mkdir(audioDir, { recursive: true });
  await mkdir(subsDir, { recursive: true });

  const segments: AudioSegment[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const idx = String(i + 1).padStart(2, "0");
    const audioPath = join(audioDir, `slide_${idx}.mp3`);
    const srtPath = join(subsDir, `slide_${idx}.srt`);

    if (!slide.speakerNotes?.trim()) {
      // Generate silence for slides without narration
      await execAsync(
        `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${config.durationPerSlide} -q:a 9 "${audioPath}"`,
      );
      await writeFile(srtPath, "");
      segments.push({ audioPath, srtPath, durationSeconds: config.durationPerSlide });
      continue;
    }

    // Use edge-tts CLI (installed via pip)
    const textFile = join(audioDir, `slide_${idx}.txt`);
    await writeFile(textFile, slide.speakerNotes);

    try {
      await execAsync(
        `edge-tts --voice "${config.ttsVoice}" --file "${textFile}" --write-media "${audioPath}" --write-subtitles "${srtPath}"`,
      );

      const duration = await getAudioDuration(audioPath);
      segments.push({ audioPath, srtPath, durationSeconds: duration });
    } catch (err) {
      console.error(`  ✗ TTS failed for slide ${i + 1}: ${(err as Error).message}`);
      // Fallback: generate silence
      await execAsync(
        `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t ${config.durationPerSlide} -q:a 9 "${audioPath}"`,
      );
      await writeFile(srtPath, "");
      segments.push({ audioPath, srtPath, durationSeconds: config.durationPerSlide });
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  console.log(
    `  ✓ ${segments.length} audio segments (total: ${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s)\n`,
  );

  return segments;
}
