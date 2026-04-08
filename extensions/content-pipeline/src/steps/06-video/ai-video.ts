/**
 * Local AI Video Generation via Hugging Face Diffusers (LTX-Video 0.9.1 2B).
 *
 * Free, local, no API keys:
 * - Apple Silicon (MPS/Metal) — M1/M2/M3/M4 with 16GB+ unified memory
 * - NVIDIA (CUDA) — RTX 2060+
 * - CPU fallback (very slow)
 *
 * Replaces the previous Wan 2.1 implementation — Wan's diffusers MPS path is
 * upstream-broken (https://github.com/Wan-Video/Wan2.1/issues/175). LTX-Video
 * 0.9.1 2B is the only open T2V DiT with verified end-to-end Apple Silicon
 * 16GB user reports (https://huggingface.co/Lightricks/LTX-Video/discussions/26).
 *
 * Setup (one-time):
 *   pip3 install diffusers torch==2.4.1 transformers accelerate imageio imageio-ffmpeg sentencepiece
 *
 * Model auto-downloads on first run (~6GB for LTX-Video 0.9.1 2B).
 * Python script: scripts/ltx-generate.py
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PipelineConfig, Wan2gpConfig } from "../../types.js";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "..", "..", "..", "scripts");

export interface AiVideoResult {
  clipPaths: string[];
  durations: number[];
  fromCache: boolean[];
}

/** Hash prompt + config to enable clip caching */
function clipCacheKey(prompt: string, config: Wan2gpConfig): string {
  return createHash("sha256")
    .update(`${prompt}|${config.model}|${config.resolution}|${config.clipDuration}`)
    .digest("hex")
    .slice(0, 12);
}

/** Check if diffusers + torch are installed */
export async function checkDiffusersInstall(): Promise<boolean> {
  const python = platform === "win32" ? "python" : "python3";
  try {
    await execAsync(`${python} -c "import diffusers, torch; print('ok')"`, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Auto-install diffusers + torch if missing (LTX-Video stack) */
async function ensureDiffusersInstalled(): Promise<void> {
  const installed = await checkDiffusersInstall();
  if (installed) return;

  console.log("  📦 Installing diffusers + torch 2.4.1 + sentencepiece (one-time setup)...");
  const pip = platform === "win32" ? "pip" : "pip3";
  try {
    await execAsync(
      // LTX-Video requires torch==2.4.1 — torch 2.5.x produces noise on MPS
      // (https://github.com/huggingface/diffusers/issues/11104)
      `${pip} install --user diffusers torch==2.4.1 transformers accelerate imageio imageio-ffmpeg sentencepiece`,
      { timeout: 600_000 },
    );
    console.log("  ✓ Dependencies installed");
  } catch (err) {
    throw new Error(
      `Failed to install LTX-Video dependencies. Run manually: ${pip} install diffusers torch==2.4.1 transformers accelerate imageio imageio-ffmpeg sentencepiece`,
    );
  }
}

/** Get video duration via ffprobe */
async function getClipDuration(clipPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${clipPath}"`,
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Generate a single video clip via LTX-Video (diffusers LTXPipeline).
 * Auto-selects device: MPS on Mac, CUDA on NVIDIA, CPU fallback.
 *
 * Note: LTX-Video is text-to-video only in this implementation.
 * `referenceImage` is currently ignored (the previous Wan I2V path doesn't
 * apply to LTX 0.9.1; an LTXImageToVideoPipeline exists but isn't wired here).
 */
async function generateClip(
  prompt: string,
  outputPath: string,
  config: Wan2gpConfig,
  _referenceImage?: string,
): Promise<void> {
  const python = platform === "win32" ? "python" : "python3";
  const scriptPath = join(SCRIPTS_DIR, "ltx-generate.py");

  const resMap: Record<string, [number, number]> = {
    "480p": [512, 320],
    "720p": [832, 480],
  };
  const [width, height] = resMap[config.resolution] ?? [512, 320];
  const frames = Math.max(8, config.clipDuration * 8); // 8 fps default

  const args = [
    `"${scriptPath}"`,
    `--prompt "${prompt.replace(/"/g, '\\"')}"`,
    `--output "${outputPath}"`,
    `--width ${width}`,
    `--height ${height}`,
    `--frames ${frames}`,
    `--fps 8`,
    `--steps 20`,
  ].join(" ");

  // LTX-Video on M3 16GB takes ~5-8 min/clip; budget generously
  const timeout = Math.max(900_000, config.clipDuration * 180_000);
  await execAsync(`${python} ${args}`, { timeout });
}

/**
 * Generate video clips for all slides locally (free).
 *
 * - Auto-installs diffusers if missing (like Ollama auto-downloads models)
 * - Parallel generation with configurable concurrency
 * - Content-hash caching (skip already-generated clips)
 * - Per-slide fallback on failure (returns empty path)
 */
export async function generateAiVideoClips(
  prompts: string[],
  outputDir: string,
  config: PipelineConfig["video"],
  referenceImages?: string[],
): Promise<AiVideoResult> {
  // Prefer the new `ltx` config block; fall back to legacy `wan2gp` for back-compat.
  const wan2gp = config.ltx ??
    config.wan2gp ?? {
      path: "",
      model: "1.3B" as const,
      resolution: "480p" as const,
      clipDuration: 5,
      concurrency: 1,
    };

  // Auto-install dependencies if needed
  await ensureDiffusersInstalled();

  const clipsDir = join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });

  const clipPaths: string[] = new Array(prompts.length).fill("");
  const durations: number[] = new Array(prompts.length).fill(0);
  const fromCache: boolean[] = new Array(prompts.length).fill(false);

  // Load cache
  const cacheFile = join(clipsDir, "cache.json");
  let cache: Record<string, string> = {};
  try {
    cache = JSON.parse(await readFile(cacheFile, "utf-8"));
  } catch {
    // No cache yet
  }

  // Check cached clips
  const toGenerate: number[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const cacheKey = clipCacheKey(prompts[i], wan2gp);
    const cachedPath = cache[cacheKey];
    if (cachedPath && existsSync(cachedPath)) {
      console.log(`  ✓ Clip ${i + 1}/${prompts.length}: cached`);
      clipPaths[i] = cachedPath;
      durations[i] = await getClipDuration(cachedPath);
      fromCache[i] = true;
    } else {
      toGenerate.push(i);
    }
  }

  if (toGenerate.length === 0) {
    console.log("  ✓ All clips loaded from cache");
    return { clipPaths, durations, fromCache };
  }

  console.log(
    `  🎬 Generating ${toGenerate.length} clip(s) locally (LTX-Video 0.9.1 2B, ${wan2gp.resolution})...`,
  );

  // Process in batches (concurrency=1 recommended for Mac 16GB)
  const concurrency = wan2gp.concurrency ?? 1;
  for (let batch = 0; batch < toGenerate.length; batch += concurrency) {
    const batchIndices = toGenerate.slice(batch, batch + concurrency);
    const batchPromises = batchIndices.map(async (i) => {
      const idx = String(i + 1).padStart(2, "0");
      const clipPath = join(clipsDir, `clip_${idx}.mp4`);
      const refImage = referenceImages?.[i];

      console.log(`  🎬 Clip ${i + 1}/${prompts.length}: generating...`);

      try {
        await generateClip(prompts[i], clipPath, wan2gp, refImage);

        if (existsSync(clipPath)) {
          clipPaths[i] = clipPath;
          durations[i] = await getClipDuration(clipPath);
          cache[clipCacheKey(prompts[i], wan2gp)] = clipPath;
          console.log(`  ✓ Clip ${i + 1}/${prompts.length}: done (${durations[i].toFixed(1)}s)`);
        } else {
          console.warn(`  ✗ Clip ${i + 1}/${prompts.length}: output file not found`);
        }
      } catch (err) {
        console.error(
          `  ✗ Clip ${i + 1}/${prompts.length}: failed — ${(err as Error).message.slice(0, 100)}`,
        );
      }
    });

    await Promise.allSettled(batchPromises);
  }

  // Save cache
  await writeFile(cacheFile, JSON.stringify(cache, null, 2));

  return { clipPaths, durations, fromCache };
}

/**
 * Compose AI video clips with TTS audio into final video.
 *
 * For each clip:
 * 1. Strip AI-generated audio (keep TTS narration)
 * 2. Loop/extend clip to match TTS duration
 * 3. Overlay TTS audio
 * 4. Concatenate all segments
 * 5. Create portrait version
 */
export async function composeAiVideo(
  clipPaths: string[],
  audioSegments: Array<{ audioPath: string; durationSeconds: number }>,
  outputDir: string,
  fps: number,
): Promise<{ landscapePath: string; portraitPath: string; durationSeconds: number }> {
  const segmentPaths: string[] = [];

  for (let i = 0; i < clipPaths.length; i++) {
    const clipPath = clipPaths[i];
    const audio = audioSegments[i];
    const idx = String(i + 1).padStart(2, "0");
    const segmentPath = join(outputDir, `segment_${idx}.mp4`);

    if (!clipPath || !existsSync(clipPath)) {
      if (audio) {
        await execAsync(
          `ffmpeg -y -f lavfi -i color=c=black:s=1920x1080:r=${fps} -i "${audio.audioPath}" ` +
            `-c:v libx264 -c:a aac -b:a 192k -shortest "${segmentPath}"`,
        );
        segmentPaths.push(segmentPath);
      }
      continue;
    }

    if (!audio) {
      await execAsync(`ffmpeg -y -i "${clipPath}" -an -c:v copy "${segmentPath}"`);
      segmentPaths.push(segmentPath);
      continue;
    }

    // Loop clip to match audio duration, strip AI audio, overlay TTS
    await execAsync(
      `ffmpeg -y -stream_loop -1 -i "${clipPath}" -i "${audio.audioPath}" ` +
        `-map 0:v -map 1:a -c:v libx264 -c:a aac -b:a 192k ` +
        `-t ${audio.durationSeconds} -r ${fps} -shortest "${segmentPath}"`,
    );
    segmentPaths.push(segmentPath);
  }

  if (segmentPaths.length === 0) {
    throw new Error("No video segments produced");
  }

  // Concatenate
  const concatList = segmentPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  const concatFile = join(outputDir, "concat.txt");
  await writeFile(concatFile, concatList);

  const landscapePath = join(outputDir, "video_landscape.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${landscapePath}"`);

  // Portrait (9:16)
  const portraitPath = join(outputDir, "video_portrait.mp4");
  try {
    await execAsync(
      `ffmpeg -y -i "${landscapePath}" ` +
        `-vf "split[original][blur];[blur]scale=1080:1920,boxblur=20[bg];[bg][original]overlay=(W-w)/2:(H-h)/2" ` +
        `-c:a copy -r ${fps} "${portraitPath}"`,
      { timeout: 300_000 },
    );
  } catch {
    console.warn("  ⚠ Portrait version failed, skipping");
  }

  // Duration
  let totalDuration = 0;
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${landscapePath}"`,
    );
    totalDuration = parseFloat(stdout.trim()) || 0;
  } catch {
    totalDuration = audioSegments.reduce((s, a) => s + a.durationSeconds, 0);
  }

  // Cleanup
  for (const p of segmentPaths) {
    await unlink(p).catch(() => {});
  }
  await unlink(concatFile).catch(() => {});

  return { landscapePath, portraitPath, durationSeconds: totalDuration };
}
