import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { requestApproval } from "./approval.js";
import { generateNewsScript } from "./content/news-writer.js";
import { generateTutorialScript } from "./content/tutorial-writer.js";
import { discord } from "./discord-notify.js";
import { scrapeAll } from "./scraper/index.js";
import { uploadRunToR2 } from "./storage.js";
import type { PipelineConfig, VideoContent, UploadResult, Article } from "./types.js";
import { generateTtsAudio, concatenateAudio } from "./video/kokoro-tts.js";
import { getWordTimestamps } from "./video/subtitles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Stage = "scrape" | "content" | "slides" | "video" | "upload";

export interface RunOptions {
  pipelineType: "news" | "tutorial";
  topic?: string;
  stopAtStage?: Stage;
  skipUpload?: boolean;
  configPath?: string;
  legacy?: boolean; // Use old Playwright+ffmpeg pipeline
}

export function loadConfig(configPath?: string): PipelineConfig {
  const path = configPath ?? join(__dirname, "..", "config.yaml");
  const raw = readFileSync(path, "utf-8");
  return YAML.parse(raw) as PipelineConfig;
}

function createOutputDir(pipelineType: string): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[T:]/g, "-").slice(0, 16);
  return join(__dirname, "..", "output", `${pipelineType}-${stamp}`);
}

const STAGE_ORDER: Stage[] = ["scrape", "content", "slides", "video", "upload"];

function shouldStop(current: Stage, stopAt?: Stage): boolean {
  if (!stopAt) return false;
  return STAGE_ORDER.indexOf(current) >= STAGE_ORDER.indexOf(stopAt);
}

export type EventCallback = (event: { stage: Stage; status: string; message: string }) => void;

export async function runPipeline(opts: RunOptions, onEvent?: EventCallback) {
  const config = loadConfig(opts.configPath);
  const outputDir = createOutputDir(opts.pipelineType);
  await mkdir(outputDir, { recursive: true });

  const emit = (stage: Stage, status: string, message: string) => {
    onEvent?.({ stage, status, message });
  };

  await discord.status(
    `🎯 **Pipeline started** — ${opts.pipelineType === "news" ? "Daily News Video" : `Tutorial: ${opts.topic}`}`,
  );

  // ── Stage 1: Scrape ──
  let articles: Article[] = [];
  if (opts.pipelineType === "news") {
    emit("scrape", "started", "Scraping tech news...");
    await discord.status("📰 **Stage 1/4**: Scraping tech news sources...");

    articles = await scrapeAll(config.sources);
    await writeFile(join(outputDir, "articles.json"), JSON.stringify(articles, null, 2));
    emit("scrape", "completed", `${articles.length} articles scraped`);

    const top10 = articles
      .slice(0, 10)
      .map((a, i) => `**${i + 1}.** ${a.title} *(${a.source})*`)
      .join("\n");
    await discord.articles(
      `📰 **Tech News Digest — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}**\n\n${top10}\n\n📊 Total: ${articles.length} articles from ${new Set(articles.map((a) => a.source)).size} sources`,
    );
    await discord.status(`✅ **Stage 1/4 complete**: ${articles.length} articles scraped`);

    if (shouldStop("scrape", opts.stopAtStage)) {
      console.log(`\nStopped after scrape. Output: ${outputDir}`);
      return { outputDir, articles };
    }
  }

  // ── Stage 2: Content ──
  emit("content", "started", "Generating content...");
  await discord.status("✍️ **Stage 2/4**: Writing video script...");

  let content: VideoContent;
  if (opts.pipelineType === "news") {
    content = await generateNewsScript(articles, config.content);
  } else {
    if (!opts.topic) throw new Error("Tutorial pipeline requires a topic");
    content = await generateTutorialScript(opts.topic, config.content);
  }
  await writeFile(join(outputDir, "script.json"), JSON.stringify(content, null, 2));
  emit("content", "completed", `Script: "${content.videoTitle}"`);

  await discord.script(
    `✍️ **Script Ready:** "${content.videoTitle}"\n\n📝 Slides: ${content.slides.length}\n🏷️ Tags: ${content.tags?.join(", ") ?? "none"}`,
  );
  await discord.status(
    `✅ **Stage 2/4 complete**: Script "${content.videoTitle}" (${content.slides.length} slides)`,
  );

  if (shouldStop("content", opts.stopAtStage)) {
    console.log(`\nStopped after content. Output: ${outputDir}`);
    return { outputDir, content };
  }

  // ── Stage 3: TTS Audio ──
  emit("slides", "started", "Generating TTS audio...");
  await discord.status("🎙️ **Stage 3/4**: Generating voice narration...");

  const audioSegments = await generateTtsAudio(content.slides, outputDir, config.video);
  const totalDur = audioSegments.reduce((s, a) => s + a.durationSeconds, 0);

  // Concatenate all audio for WhisperX
  const combinedAudioPath = join(outputDir, "combined-audio.wav");
  await concatenateAudio(audioSegments, combinedAudioPath);

  // Get word-level timestamps
  const words = await getWordTimestamps(combinedAudioPath, outputDir);

  await discord.status(
    `✅ **Stage 3/4 complete**: ${audioSegments.length} audio segments (${Math.floor(totalDur / 60)}m ${Math.floor(totalDur % 60)}s), ${words.length} word timestamps`,
  );

  if (shouldStop("slides", opts.stopAtStage)) {
    console.log(`\nStopped after TTS. Output: ${outputDir}`);
    return { outputDir, content, audioSegments, words };
  }

  // ── Stage 4: Render Video with Remotion ──
  emit("video", "started", "Rendering video with Remotion...");
  await discord.status("🎬 **Stage 4/4**: Rendering Apple-style video with Remotion...");

  const fps = config.video.fps ?? 30;

  // Calculate frame durations from audio
  const slidesWithFrames = content.slides.map((slide, i) => ({
    ...slide,
    durationFrames: Math.max(60, Math.ceil((audioSegments[i]?.durationSeconds ?? 5) * fps)),
  }));

  const videoLandscapePath = join(outputDir, "video_landscape.mp4");

  // Copy audio to Remotion's public/ directory for staticFile() access
  const publicDir = join(__dirname, "..", "public");
  const { mkdirSync, copyFileSync } = await import("node:fs");
  mkdirSync(publicDir, { recursive: true });
  const publicAudioName = "narration.wav";
  if (existsSync(combinedAudioPath)) {
    copyFileSync(combinedAudioPath, join(publicDir, publicAudioName));
  }

  try {
    const { renderVideo } = await import("./remotion/render.js");

    await renderVideo(
      {
        slides: slidesWithFrames,
        audioPath: existsSync(combinedAudioPath) ? publicAudioName : "",
        words,
        fps,
      },
      videoLandscapePath,
      (pct) => {
        if (pct % 25 === 0) console.log(`  Rendering: ${pct}%`);
      },
    );
  } catch (err) {
    console.error(`  ❌ Remotion render failed: ${(err as Error).message}`);
    await discord.status(`❌ Remotion render failed: ${(err as Error).message.slice(0, 100)}`);
    return { outputDir, content, audioSegments };
  }

  // Get video duration
  const { exec: execCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execCb);
  let videoDuration = totalDur;
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoLandscapePath}"`,
    );
    videoDuration = parseFloat(stdout.trim()) || totalDur;
  } catch {}

  // Create portrait version (9:16) with blurred background
  const videoPortraitPath = join(outputDir, "video_portrait.mp4");
  try {
    await execAsync(
      `ffmpeg -y -i "${videoLandscapePath}" -vf "split[original][blur];[blur]scale=1080:1920,boxblur=20[bg];[bg][original]overlay=(W-w)/2:(H-h)/2" -c:a copy -r ${fps} "${videoPortraitPath}"`,
      { timeout: 300_000 },
    );
  } catch {
    console.warn("  ⚠ Portrait version failed, skipping");
  }

  const videoResult = {
    landscapePath: videoLandscapePath,
    portraitPath: videoPortraitPath,
    durationSeconds: videoDuration,
    subtitlePath: join(outputDir, "word-timestamps.json"),
  };

  const dur = `${Math.floor(videoDuration / 60)}m ${Math.floor(videoDuration % 60)}s`;

  await discord.videoProgress(
    `🎬 **Video rendered!**\n📐 Landscape: 1920x1080\n📱 Portrait: 1080x1920\n⏱️ Duration: ${dur}`,
  );
  await discord.status(`✅ **Stage 4/4 complete**: Video ready (${dur})`);

  emit("video", "completed", `Video: ${dur}`);

  // Upload to R2
  const runId = basename(outputDir);
  console.log("\n☁️ Uploading to R2 cloud storage...");
  await discord.status("☁️ Uploading to cloud storage...");
  const r2Urls = await uploadRunToR2(outputDir, runId);

  // Request approval
  await discord.status(`✅ **Video ready!** Requesting your approval...`);
  const approvalMsgId = await requestApproval({
    runId,
    outputDir,
    videoTitle: content.videoTitle,
    duration: dur,
    slideCount: content.slides.length,
    r2Urls,
    pipelineType: opts.pipelineType,
  });

  console.log(`\n🔔 Video ready. Approval requested in Discord. Output: ${outputDir}`);
  console.log(`   Click Approve in Discord or run: npx tsx src/cli.ts approve`);
  return { outputDir, content, videoResult, r2Urls, approvalMsgId };
}
