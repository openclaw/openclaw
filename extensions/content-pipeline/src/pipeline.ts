import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { generateNewsScript } from "./content/news-writer.js";
import { generateTutorialScript } from "./content/tutorial-writer.js";
import { scrapeAll } from "./scraper/index.js";
import { renderSlides } from "./slides/renderer.js";
import type { PipelineConfig, VideoContent, UploadResult, Article } from "./types.js";
import { uploadToFacebook } from "./upload/facebook.js";
import { uploadToTiktok } from "./upload/tiktok.js";
import { uploadToYoutube } from "./upload/youtube.js";
import { composeVideo } from "./video/composer.js";
import { generateTts } from "./video/tts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Stage = "scrape" | "content" | "slides" | "video" | "upload";

export interface RunOptions {
  pipelineType: "news" | "tutorial";
  topic?: string;
  stopAtStage?: Stage;
  skipUpload?: boolean;
  configPath?: string;
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

  // ── Stage 1: Scrape ──
  let articles: Article[] = [];
  if (opts.pipelineType === "news") {
    emit("scrape", "started", "Scraping tech news...");
    articles = await scrapeAll(config.sources);
    await writeFile(join(outputDir, "articles.json"), JSON.stringify(articles, null, 2));
    emit("scrape", "completed", `${articles.length} articles scraped`);

    if (shouldStop("scrape", opts.stopAtStage)) {
      console.log(`\nStopped after scrape. Output: ${outputDir}`);
      return { outputDir, articles };
    }
  }

  // ── Stage 2: Content ──
  emit("content", "started", "Generating content...");
  let content: VideoContent;
  if (opts.pipelineType === "news") {
    content = await generateNewsScript(articles, config.content);
  } else {
    if (!opts.topic) throw new Error("Tutorial pipeline requires a topic");
    content = await generateTutorialScript(opts.topic, config.content);
  }
  await writeFile(join(outputDir, "script.json"), JSON.stringify(content, null, 2));
  emit("content", "completed", `Script: "${content.videoTitle}"`);

  if (shouldStop("content", opts.stopAtStage)) {
    console.log(`\nStopped after content. Output: ${outputDir}`);
    return { outputDir, content };
  }

  // ── Stage 3: Slides ──
  emit("slides", "started", "Rendering slides...");
  const slidePaths = await renderSlides(content, outputDir, config.slides);
  emit("slides", "completed", `${slidePaths.length} slides rendered`);

  if (shouldStop("slides", opts.stopAtStage)) {
    console.log(`\nStopped after slides. Output: ${outputDir}`);
    return { outputDir, content, slidePaths };
  }

  // ── Stage 4: Video ──
  emit("video", "started", "Producing video...");
  const audioSegments = await generateTts(content.slides, outputDir, config.video);
  const videoResult = await composeVideo(slidePaths, audioSegments, outputDir, config.video);
  emit("video", "completed", `Video: ${Math.floor(videoResult.durationSeconds / 60)}m`);

  if (shouldStop("video", opts.stopAtStage) || opts.skipUpload) {
    console.log(`\nVideo ready. Output: ${outputDir}`);
    return { outputDir, content, videoResult };
  }

  // ── Stage 5: Upload ──
  emit("upload", "started", "Uploading to platforms...");
  const uploads: UploadResult[] = [];

  // YouTube
  if (config.upload.youtube.enabled) {
    try {
      const url = await uploadToYoutube(
        videoResult,
        content,
        config.upload.youtube,
        "client_secrets.json",
      );
      uploads.push({ platform: "youtube", url, status: "success" });
    } catch (err) {
      uploads.push({ platform: "youtube", status: "error", error: (err as Error).message });
    }
  }

  // TikTok
  if (config.upload.tiktok.enabled) {
    try {
      await uploadToTiktok(videoResult, content, config.upload.tiktok.cookiesPath);
      uploads.push({ platform: "tiktok", status: "success" });
    } catch (err) {
      uploads.push({ platform: "tiktok", status: "error", error: (err as Error).message });
    }
  }

  // Facebook
  if (config.upload.facebook.enabled) {
    const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (fbToken && config.upload.facebook.pageId) {
      try {
        const url = await uploadToFacebook(
          videoResult,
          content,
          config.upload.facebook.pageId,
          fbToken,
        );
        uploads.push({ platform: "facebook", url, status: "success" });
      } catch (err) {
        uploads.push({ platform: "facebook", status: "error", error: (err as Error).message });
      }
    } else {
      uploads.push({ platform: "facebook", status: "skipped", error: "Missing credentials" });
    }
  }

  await writeFile(join(outputDir, "upload_results.json"), JSON.stringify(uploads, null, 2));
  emit("upload", "completed", uploads.map((u) => `${u.platform}: ${u.status}`).join(", "));

  console.log(`\n✅ Pipeline complete! Output: ${outputDir}`);
  return { outputDir, content, videoResult, uploads };
}
