/**
 * B-roll video engine — uses Pexels stock footage instead of generating AI clips.
 *
 * For each slide, picks a search term (concept keyword first, slide title as
 * fallback), searches Pexels, downloads the best landscape MP4, and trims/loops
 * it to match the TTS narration duration. Then composes everything via ffmpeg.
 *
 * Free, instant, no GPU, real footage. The default story-slide engine when
 * `video.engine = "pexels"` or "hybrid".
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WordTimestamp } from "../../remotion/types.js";
import type { AudioSegment, PipelineConfig, SelectedConcept, SlideContent } from "../../types.js";
import { downloadVideo, pickBestFile, searchPexels } from "./pexels.js";

const execAsync = promisify(exec);

export interface BrollResult {
  /** One MP4 path per slide; empty string if download/compose failed for that slide */
  clipPaths: string[];
  /** Per-slide duration in seconds (from ffprobe) */
  durations: number[];
  /** Per-slide search term used for Pexels lookup */
  searchTerms: string[];
}

/**
 * Build a Pexels search query for a slide.
 *
 * Prefers concept keywords (more specific to the story) but falls back to slide
 * title tokens if no concept is provided. Strips stopwords and short tokens.
 */
export function buildSearchTerm(
  slide: SlideContent,
  index: number,
  concept?: SelectedConcept,
): string {
  // Use a different concept keyword per slide so b-roll varies across the video
  if (concept && concept.keywords.length > 0) {
    const kw = concept.keywords[index % concept.keywords.length];
    if (kw && kw.length >= 3) return kw;
  }

  // Fallback: extract a meaningful token from the title
  const STOPWORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "what"]);
  const tokens = slide.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (tokens[0]) return tokens[0];
  // Last-resort fallback to the first non-empty title token, then the generic "technology"
  const firstWord = slide.title.split(/\s+/).find((w) => w.trim().length > 0);
  return firstWord ?? "technology";
}

/** Format seconds as SRT timestamp `HH:MM:SS,mmm`. Pure helper. */
export function formatSrtTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Generate an SRT subtitle file from per-slide audio segments + slide notes.
 *
 * If `words` is provided (from whisper.cpp), uses word-level timestamps for
 * karaoke-style captions chunked into ~7-word phrases. Otherwise falls back to
 * one SRT entry per slide spanning that slide's audio duration.
 */
export function buildBrollSrt(
  slides: SlideContent[],
  audioSegments: AudioSegment[],
  words?: WordTimestamp[],
): string {
  const lines: string[] = [];
  let entryIdx = 1;

  if (words && words.length > 0) {
    // Word-level karaoke: group ~7 words per caption
    const CHUNK = 7;
    for (let i = 0; i < words.length; i += CHUNK) {
      const chunk = words.slice(i, i + CHUNK);
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const text = chunk
        .map((w) => w.word.trim())
        .join(" ")
        .trim();
      if (!text) continue;
      lines.push(String(entryIdx++));
      lines.push(`${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`);
      lines.push(text);
      lines.push("");
    }
    return lines.join("\n");
  }

  // Fallback: per-slide whole-segment captions from speakerNotes
  let offset = 0;
  for (let i = 0; i < slides.length; i++) {
    const audio = audioSegments[i];
    if (!audio) continue;
    const text = (slides[i].speakerNotes || slides[i].title || "").trim();
    if (text) {
      lines.push(String(entryIdx++));
      lines.push(
        `${formatSrtTimestamp(offset)} --> ${formatSrtTimestamp(offset + audio.durationSeconds)}`,
      );
      // Wrap to ~50 chars per line for readability
      lines.push(wrapForSrt(text, 50));
      lines.push("");
    }
    offset += audio.durationSeconds;
  }
  return lines.join("\n");
}

/** Pure helper: wrap text into lines of at most `maxChars`, breaking on word boundaries. */
export function wrapForSrt(text: string, maxChars: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length <= maxChars) {
      current = `${current} ${w}`;
    } else {
      out.push(current);
      current = w;
    }
  }
  if (current) out.push(current);
  return out.join("\n");
}

/** Escape a string for ffmpeg drawtext text= option. */
function escapeDrawtext(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
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
 * Trim or loop a video to match a target duration.
 * - If source is longer: trim to target.
 * - If source is shorter: loop until target is reached.
 * Strips audio (TTS will be overlaid downstream).
 */
async function fitToDuration(
  inputPath: string,
  outputPath: string,
  targetSec: number,
  width: number,
  height: number,
  fps: number,
): Promise<void> {
  const sourceDur = await ffprobeDuration(inputPath);
  if (sourceDur <= 0) {
    throw new Error(`source video has zero duration: ${inputPath}`);
  }

  // Scale + center-crop to target dimensions, no audio
  const vfilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;

  if (sourceDur >= targetSec) {
    // Trim
    await execAsync(
      `ffmpeg -y -i "${inputPath}" -t ${targetSec.toFixed(2)} -vf "${vfilter}" -an -r ${fps} -c:v libx264 -pix_fmt yuv420p "${outputPath}"`,
      { timeout: 60_000 },
    );
  } else {
    // Loop
    const loops = Math.ceil(targetSec / sourceDur);
    await execAsync(
      `ffmpeg -y -stream_loop ${loops} -i "${inputPath}" -t ${targetSec.toFixed(2)} -vf "${vfilter}" -an -r ${fps} -c:v libx264 -pix_fmt yuv420p "${outputPath}"`,
      { timeout: 60_000 },
    );
  }
}

/**
 * Generate B-roll clips for every slide. Picks one Pexels video per slide,
 * downloads it, fits it to the slide's TTS duration, and returns clip paths.
 *
 * On per-slide failure (no result, download error, ffmpeg error), the clip
 * path is set to "" so the caller can substitute a static color frame.
 */
export async function generateBrollClips(
  slides: SlideContent[],
  audioSegments: AudioSegment[],
  outputDir: string,
  config: PipelineConfig["video"],
  concept?: SelectedConcept,
): Promise<BrollResult> {
  const clipsDir = join(outputDir, "broll");
  await mkdir(clipsDir, { recursive: true });

  const fps = config.fps ?? 30;
  const width = config.width ?? 1920;
  const height = config.height ?? 1080;

  const clipPaths: string[] = new Array(slides.length).fill("");
  const durations: number[] = new Array(slides.length).fill(0);
  const searchTerms: string[] = new Array(slides.length).fill("");

  console.log(`📽️  Stage 4 (Pexels B-roll): Fetching ${slides.length} clip(s)...`);

  for (let i = 0; i < slides.length; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const targetDur = audioSegments[i]?.durationSeconds ?? config.durationPerSlide ?? 5;
    const term = buildSearchTerm(slides[i], i, concept);
    searchTerms[i] = term;

    const rawPath = join(clipsDir, `raw_${idx}.mp4`);
    const fitPath = join(clipsDir, `clip_${idx}.mp4`);

    try {
      console.log(`  🔎 Slide ${i + 1}/${slides.length}: searching "${term}"...`);
      const results = await searchPexels(term, {
        perPage: 10,
        orientation: "landscape",
        size: "medium",
      });
      if (results.length === 0) {
        console.warn(`  ⚠ No Pexels results for "${term}"`);
        continue;
      }

      // Pick the first result whose best file fits target dimensions
      const pick = results[0];
      const file = pickBestFile(pick.video_files, width, height);
      if (!file) {
        console.warn(`  ⚠ No suitable file in Pexels result for "${term}"`);
        continue;
      }

      await downloadVideo(file.link, rawPath);
      await fitToDuration(rawPath, fitPath, targetDur, width, height, fps);

      if (existsSync(fitPath)) {
        clipPaths[i] = fitPath;
        durations[i] = await ffprobeDuration(fitPath);
        console.log(
          `  ✓ Slide ${i + 1}/${slides.length}: ${durations[i].toFixed(1)}s from ${pick.user.name}`,
        );
      }
    } catch (err) {
      console.warn(
        `  ✗ Slide ${i + 1}/${slides.length} failed: ${(err as Error).message.slice(0, 120)}`,
      );
    } finally {
      // Clean up the raw download (kept the fitted version)
      await unlink(rawPath).catch(() => {});
    }
  }

  return { clipPaths, durations, searchTerms };
}

/**
 * Compose B-roll clips with TTS narration into a final video.
 *
 * For each slide:
 *   - If clip available: overlay TTS audio + slide title (top-left) + bottom dark gradient
 *   - If clip missing: create a black-frame video with TTS audio
 *
 * After all segments are concatenated, burns subtitles (whisper.cpp word
 * timestamps if available, else per-slide speakerNotes) onto the final video.
 */
export async function composeBrollVideo(
  clipPaths: string[],
  slides: SlideContent[],
  audioSegments: AudioSegment[],
  outputDir: string,
  config: PipelineConfig["video"],
  words?: WordTimestamp[],
): Promise<{
  landscapePath: string;
  portraitPath: string;
  durationSeconds: number;
  subtitlePath: string;
}> {
  const fps = config.fps ?? 30;
  const width = config.width ?? 1920;
  const height = config.height ?? 1080;
  const segmentPaths: string[] = [];

  // Per-slide compose: clip + TTS audio + bottom darken filter for caption readability.
  // Title rendering and word captions are added in the post-concat subtitle burn step.
  // Drawtext overlays were too fragile (font path issues on Mac) so they're handled via SRT.
  for (let i = 0; i < clipPaths.length; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const clipPath = clipPaths[i];
    const audio = audioSegments[i];
    const segPath = join(outputDir, `segment_${idx}.mp4`);

    const buildSegment = async (): Promise<boolean> => {
      if (clipPath && existsSync(clipPath) && audio) {
        // Darken bottom 30% so subtitle text reads cleanly over busy footage
        const vfilter = "drawbox=x=0:y=ih*0.7:w=iw:h=ih*0.3:color=black@0.55:t=fill";
        try {
          await execAsync(
            `ffmpeg -y -i "${clipPath}" -i "${audio.audioPath}" -map 0:v -map 1:a -vf "${vfilter}" -c:v libx264 -c:a aac -b:a 192k -t ${audio.durationSeconds.toFixed(2)} -r ${fps} -shortest -pix_fmt yuv420p "${segPath}"`,
            { timeout: 180_000 },
          );
          return true;
        } catch (err) {
          console.warn(
            `  ⚠ Slide ${i + 1} compose with darken failed, retrying without filter: ${(err as Error).message.slice(0, 100)}`,
          );
          try {
            await execAsync(
              `ffmpeg -y -i "${clipPath}" -i "${audio.audioPath}" -map 0:v -map 1:a -c:v libx264 -c:a aac -b:a 192k -t ${audio.durationSeconds.toFixed(2)} -r ${fps} -shortest -pix_fmt yuv420p "${segPath}"`,
              { timeout: 120_000 },
            );
            return true;
          } catch (retryErr) {
            console.warn(
              `  ✗ Slide ${i + 1} plain compose also failed: ${(retryErr as Error).message.slice(0, 100)}`,
            );
            return false;
          }
        }
      }
      return false;
    };

    const ok = await buildSegment();
    if (ok) {
      segmentPaths.push(segPath);
    } else if (audio) {
      // Black frame fallback so the slide still gets its narration
      try {
        await execAsync(
          `ffmpeg -y -f lavfi -i color=c=black:s=${width}x${height}:r=${fps} -i "${audio.audioPath}" -c:v libx264 -c:a aac -b:a 192k -t ${audio.durationSeconds.toFixed(2)} -shortest -pix_fmt yuv420p "${segPath}"`,
          { timeout: 60_000 },
        );
        segmentPaths.push(segPath);
        console.warn(`  ⚠ Slide ${i + 1}: using black frame fallback`);
      } catch (blackErr) {
        console.warn(
          `  ✗ Slide ${i + 1} black-frame fallback also failed (skipped): ${(blackErr as Error).message.slice(0, 100)}`,
        );
      }
    }
  }

  if (segmentPaths.length === 0) {
    throw new Error("composeBrollVideo: no segments produced");
  }

  // Concat segments → raw landscape (without subtitles)
  const concatList = segmentPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n");
  const concatFile = join(outputDir, "broll-concat.txt");
  await writeFile(concatFile, concatList);

  const rawPath = join(outputDir, "video_landscape_raw.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${rawPath}"`);

  // Generate SRT — word-level karaoke if whisper.cpp gave us words, else per-slide
  const subtitlePath = join(outputDir, "subtitles.srt");
  const srt = buildBrollSrt(slides, audioSegments, words);
  await writeFile(subtitlePath, srt);

  // Burn subtitles into the final landscape video
  const landscapePath = join(outputDir, "video_landscape.mp4");
  if (srt.trim()) {
    const escapedSubPath = subtitlePath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\\\:")
      .replace(/'/g, "\\\\'");
    try {
      await execAsync(
        `ffmpeg -y -i "${rawPath}" -vf "subtitles='${escapedSubPath}':force_style='FontName=Helvetica,FontSize=22,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=0,Alignment=2,MarginV=70'" -c:a copy "${landscapePath}"`,
        { timeout: 300_000 },
      );
    } catch (err) {
      console.warn(
        `  ⚠ Subtitle burn failed, using video without subtitles: ${(err as Error).message.slice(0, 100)}`,
      );
      const { copyFile } = await import("node:fs/promises");
      await copyFile(rawPath, landscapePath);
    }
  } else {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(rawPath, landscapePath);
  }
  await unlink(rawPath).catch(() => {});

  // Portrait (9:16) with blurred background
  const portraitPath = join(outputDir, "video_portrait.mp4");
  try {
    await execAsync(
      `ffmpeg -y -i "${landscapePath}" -vf "split[original][blur];[blur]scale=1080:1920,boxblur=20[bg];[bg][original]overlay=(W-w)/2:(H-h)/2" -c:a copy -r ${fps} "${portraitPath}"`,
      { timeout: 300_000 },
    );
  } catch {
    console.warn("  ⚠ Portrait version failed, skipping");
  }

  // Total duration
  const durationSeconds = await ffprobeDuration(landscapePath);

  // Cleanup
  for (const p of segmentPaths) {
    await unlink(p).catch(() => {});
  }
  await unlink(concatFile).catch(() => {});

  return { landscapePath, portraitPath, durationSeconds, subtitlePath };
}
