/**
 * Step 5 — TTS (single-concept deep-dive narration).
 *
 * For each slide:
 *   1. Sanitize speakerNotes (strip URLs, markdown, source citations, emoji)
 *   2. Split into sentence-sized chunks (default <= 280 chars each)
 *   3. Generate TTS for each chunk with the primary engine
 *   4. Per-chunk fallback to the other engine on failure, silence as last resort
 *   5. ffmpeg concat all chunks into one `slide_NN.wav` per slide
 *
 * Pure logic (sanitize + split) lives in `./sanitize.ts`, engine adapters
 * in `./engines.ts`. This file is the orchestrator.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AudioSegment, PipelineConfig, SlideContent } from "../../types.js";
import { edgeTtsAdapter, kokoroTts, type TtsEngineResult } from "./engines.js";
import { sanitizeForTts, splitSentences } from "./sanitize.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "..", "..", "scripts");
const KOKORO_SCRIPT = join(SCRIPTS_DIR, "kokoro-generate.py");
const KOKORO_MODEL_PATH = join(homedir(), ".openclaw", "models", "kokoro-v1.0.onnx");

type TtsEngine = "kokoro" | "edge-tts";

interface ResolvedTtsConfig {
  engine: TtsEngine;
  fallback: TtsEngine;
  kokoroVoice: string;
  kokoroSpeed: number;
  edgeTtsVoice: string;
  chunkBySentence: boolean;
}

function resolveTtsConfig(config: PipelineConfig["video"]): ResolvedTtsConfig {
  const ttsCfg = config.tts ?? {};
  const engine: TtsEngine = ttsCfg.engine ?? config.ttsEngine ?? "kokoro";
  return {
    engine,
    fallback: engine === "kokoro" ? "edge-tts" : "kokoro",
    kokoroVoice: ttsCfg.kokoro?.voice ?? config.ttsVoice ?? "af_heart",
    kokoroSpeed: ttsCfg.kokoro?.speed ?? config.ttsSpeed ?? 1.0,
    // CRITICAL: don't fall back to config.ttsVoice here — Kokoro voices like
    // "af_heart" are NOT valid edge-tts voices and would cause every call to fail.
    edgeTtsVoice: ttsCfg.edgeTts?.voice ?? "en-US-AndrewNeural",
    chunkBySentence: ttsCfg.chunkBySentence !== false,
  };
}

async function runEngine(
  engine: TtsEngine,
  text: string,
  outputPath: string,
  cfg: ResolvedTtsConfig,
): Promise<TtsEngineResult> {
  if (engine === "kokoro") {
    return kokoroTts(text, outputPath, {
      voice: cfg.kokoroVoice,
      speed: cfg.kokoroSpeed,
      scriptPath: KOKORO_SCRIPT,
    });
  }
  return edgeTtsAdapter(text, outputPath, { voice: cfg.edgeTtsVoice });
}

/** Generate a short silence WAV as the last-resort per-chunk fallback. */
async function generateSilence(path: string, durationSec: number): Promise<void> {
  await execAsync(
    `ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${durationSec} -q:a 9 "${path}"`,
  );
}

/** Concat a list of chunk WAVs into one slide WAV via ffmpeg concat demuxer. */
async function concatChunks(chunkPaths: string[], outputPath: string): Promise<void> {
  const listFile = outputPath.replace(/\.wav$/, "-chunks.txt");
  const lines = chunkPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  await writeFile(listFile, lines);
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`);
  await unlink(listFile).catch(() => {});
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
 * Main entry — generate per-slide audio with sentence-level chunking and
 * cross-engine fallback.
 */
export async function generateTtsAudio(
  slides: SlideContent[],
  outputDir: string,
  config: PipelineConfig["video"],
): Promise<AudioSegment[]> {
  const cfg = resolveTtsConfig(config);

  // Startup check: if Kokoro is the primary engine and the model file is
  // missing, silently switch to edge-tts. This avoids 7 per-slide failures
  // when the model just hasn't been downloaded.
  let effectivePrimary: TtsEngine = cfg.engine;
  if (cfg.engine === "kokoro" && !existsSync(KOKORO_MODEL_PATH)) {
    console.warn(
      `  ⚠ Kokoro model missing at ${KOKORO_MODEL_PATH}, switching primary engine to edge-tts`,
    );
    effectivePrimary = "edge-tts";
  }
  const effectiveFallback: TtsEngine = effectivePrimary === "kokoro" ? "edge-tts" : "kokoro";

  console.log(
    `🎙️ TTS engine: ${effectivePrimary}${effectivePrimary !== cfg.fallback ? ` (fallback: ${effectiveFallback})` : ""}${cfg.chunkBySentence ? ", chunked" : ""}`,
  );

  const audioDir = join(outputDir, "audio");
  await mkdir(audioDir, { recursive: true });

  const segments: AudioSegment[] = [];
  let totalChunks = 0;
  let okChunks = 0;
  let failedChunks = 0;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const idx = String(i + 1).padStart(2, "0");
    const slideAudioPath = join(audioDir, `slide_${idx}.wav`);
    const srtPath = join(audioDir, `slide_${idx}.srt`);

    // Sanitize + chunk
    const sanitized = sanitizeForTts(slide.speakerNotes ?? "");
    if (!sanitized.trim()) {
      // No narration at all — emit silence for the slide
      await generateSilence(slideAudioPath, config.durationPerSlide);
      await writeFile(srtPath, "");
      segments.push({
        audioPath: slideAudioPath,
        srtPath,
        durationSeconds: config.durationPerSlide,
      });
      continue;
    }

    const chunks = cfg.chunkBySentence ? splitSentences(sanitized, 280) : [sanitized];
    totalChunks += chunks.length;

    // Generate each chunk with per-chunk engine fallback
    const chunkPaths: string[] = [];
    for (let j = 0; j < chunks.length; j++) {
      const chunkText = chunks[j];
      const chunkIdx = String(j + 1).padStart(2, "0");
      const chunkPath = join(audioDir, `slide_${idx}_chunk_${chunkIdx}.wav`);

      let ok = false;
      try {
        await runEngine(effectivePrimary, chunkText, chunkPath, cfg);
        ok = true;
      } catch (err) {
        console.warn(
          `  ⚠ ${effectivePrimary} failed on slide ${i + 1} chunk ${j + 1}: ${(err as Error).message.slice(0, 120)}`,
        );
        try {
          await runEngine(effectiveFallback, chunkText, chunkPath, cfg);
          ok = true;
          console.log(`    ↳ recovered via ${effectiveFallback}`);
        } catch (fbErr) {
          console.warn(
            `  ✗ ${effectiveFallback} also failed: ${(fbErr as Error).message.slice(0, 120)}`,
          );
        }
      }

      if (ok && existsSync(chunkPath)) {
        chunkPaths.push(chunkPath);
        okChunks++;
      } else {
        // Last resort: short silence so the slide still has something
        const silencePath = chunkPath;
        await generateSilence(silencePath, 2.0);
        chunkPaths.push(silencePath);
        failedChunks++;
      }
    }

    // Concat chunks → one slide file
    if (chunkPaths.length === 1) {
      // Single chunk — just rename/copy
      await execAsync(`ffmpeg -y -i "${chunkPaths[0]}" -c copy "${slideAudioPath}"`);
    } else {
      await concatChunks(chunkPaths, slideAudioPath);
    }

    // Clean up chunk files after concat (optional — keeps output dir tidy)
    for (const p of chunkPaths) {
      if (p !== slideAudioPath) await unlink(p).catch(() => {});
    }

    const duration = await ffprobeDuration(slideAudioPath);
    await writeFile(srtPath, ""); // Legacy empty SRT — word timestamps come from WhisperX
    segments.push({ audioPath: slideAudioPath, srtPath, durationSeconds: duration });
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  console.log(
    `  ✓ ${segments.length} slide(s), ${okChunks}/${totalChunks} chunks ok${failedChunks ? `, ${failedChunks} fell back to silence` : ""} (total: ${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s)`,
  );

  return segments;
}

/** Concatenate all slide audio segments into a single WAV file. */
export async function concatenateAudio(
  segments: AudioSegment[],
  outputPath: string,
): Promise<void> {
  const listFile = outputPath.replace(/\.wav$/, "-list.txt");
  const lines = segments.map((s) => `file '${s.audioPath.replace(/\\/g, "/")}'`).join("\n");
  await writeFile(listFile, lines);
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`);
  await unlink(listFile).catch(() => {});
}
