import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { requestApproval } from "./approval.js";
import { generateNewsScript } from "./content/news-writer.js";
import { generateTutorialScript } from "./content/tutorial-writer.js";
import { discord } from "./discord-notify.js";
import { scrapeAll } from "./steps/01-scrape/index.js";
import { selectConcept } from "./steps/02-concept/index.js";
import { findRelatedSources } from "./steps/03-related/index.js";
import { generateConceptScript } from "./steps/04-script/index.js";
import { generateTtsAudio, concatenateAudio } from "./steps/05-tts/index.js";
import { generateAiVideoClips, composeAiVideo } from "./steps/06-video/ai-video.js";
import { generateBrollClips, composeBrollVideo } from "./steps/06-video/broll.js";
import { optimizePrompts } from "./steps/06-video/prompt-optimizer.js";
import { getWordTimestamps } from "./steps/06-video/subtitles.js";
import { uploadRunToR2 } from "./storage.js";
import type {
  PipelineConfig,
  VideoContent,
  UploadResult,
  Article,
  FullArticle,
  SelectedConcept,
  VideoEngine,
} from "./types.js";

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

    articles = await scrapeAll(config.sources, {
      poolSize: config.content.poolSize,
      maxPerSource: config.content.maxPerSource,
    });
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
  }

  // ── Stage 1.5: Concept selection ──
  // Scores the candidate pool on necessity / attractiveness / novelty / depth
  // and picks ONE concept to anchor the video. Stage 2 (script) still uses
  // the legacy multi-story path until Step 4 wires the concept in.
  let concept: SelectedConcept | undefined;
  if (opts.pipelineType === "news") {
    emit("scrape", "started", "Selecting concept...");
    await discord.status("🎯 **Concept selection**: scoring articles…");

    try {
      concept = await selectConcept(articles, config.content);
      await writeFile(join(outputDir, "concept.json"), JSON.stringify(concept, null, 2));

      const top = concept.scored
        .slice(0, 3)
        .map(
          (s, i) =>
            `**${i + 1}.** ${s.article.title} *(${s.article.source})* — total **${s.score.total}** \`(N${s.score.necessity}/A${s.score.attractiveness}/V${s.score.novelty}/D${s.score.depth})\``,
        )
        .join("\n");
      await discord.articles(
        `🎯 **Concept Selected: ${concept.title}**\n_${concept.theme}_\n\n**Top candidates:**\n${top}\n\n🔑 Keywords: ${concept.keywords.join(", ")}`,
      );
      await discord.status(`✅ **Concept stage complete**: ${concept.title}`);
    } catch (err) {
      console.warn(`  ⚠ Concept selection failed: ${(err as Error).message.slice(0, 150)}`);
      await discord.status(
        `⚠ Concept selection failed, falling back to multi-story: ${(err as Error).message.slice(0, 100)}`,
      );
      // Don't abort the pipeline — Stage 2 still uses the legacy path until Step 4
    }
  }

  // ── Stage 1.6: Related sources ──
  // Picks the pool articles that cover the same concept (by keyword overlap)
  // and fetches their full HTML body so Step 4 has real material to write
  // a deep script from. Stage 2 still uses the legacy multi-story path until
  // Step 4 wires `relatedSources` in.
  let relatedSources: FullArticle[] = [];
  if (opts.pipelineType === "news" && concept) {
    emit("scrape", "started", "Fetching related sources...");
    await discord.status("📚 **Fetching related sources**: deepening the concept…");

    try {
      relatedSources = await findRelatedSources(concept, articles, config.content);
      await writeFile(
        join(outputDir, "related-sources.json"),
        JSON.stringify(relatedSources, null, 2),
      );

      const ok = relatedSources.filter((s) => s.fetchOk).length;
      const total = relatedSources.length;
      const totalChars = relatedSources.reduce((s, a) => s + a.fullText.length, 0);
      const breakdown = relatedSources
        .map(
          (s, i) =>
            `**${i + 1}.** ${s.title.slice(0, 60)} *(${s.source})* — ${
              s.fetchOk
                ? `${s.fullText.length} chars, ${s.keywordMatches} kw`
                : `❌ ${s.fetchError ?? "fetch failed"}`
            }`,
        )
        .join("\n");
      await discord.articles(
        `📚 **Related sources fetched** (${ok}/${total} ok, ${totalChars} chars total)\n\n${breakdown}`,
      );
      await discord.status(`✅ **Related sources stage complete**: ${ok}/${total} fetched`);
    } catch (err) {
      console.warn(`  ⚠ Related-source fetch failed: ${(err as Error).message.slice(0, 150)}`);
      await discord.status(
        `⚠ Related sources failed, Stage 2 will use only the seed: ${(err as Error).message.slice(0, 100)}`,
      );
    }
  }

  if (opts.pipelineType === "news" && shouldStop("scrape", opts.stopAtStage)) {
    console.log(`\nStopped after scrape + concept + related. Output: ${outputDir}`);
    return { outputDir, articles, concept, relatedSources };
  }

  // ── Stage 2: Content ──
  emit("content", "started", "Generating content...");
  await discord.status("✍️ **Stage 2/4**: Writing video script...");

  let content: VideoContent;
  if (opts.pipelineType === "news") {
    const mode = config.content.mode ?? "single-concept";
    const usableSources = relatedSources.filter((s) => s.fetchOk && s.fullText.length > 0);
    const hasRichConcept =
      mode === "single-concept" && concept !== undefined && usableSources.length > 0;

    if (hasRichConcept && concept) {
      try {
        content = await generateConceptScript(concept, relatedSources, config.content);
        await discord.status(
          `✅ **Deep-dive script ready**: "${content.videoTitle}" (${content.slides.length} slides)`,
        );
      } catch (err) {
        console.warn(
          `  ⚠ Concept script failed, falling back to multi-story: ${(err as Error).message.slice(0, 150)}`,
        );
        await discord.status(
          `⚠ Concept script failed, falling back to multi-story: ${(err as Error).message.slice(0, 100)}`,
        );
        content = await generateNewsScript(articles, config.content);
      }
    } else {
      if (mode === "single-concept") {
        console.log(`  ℹ No concept/sources available, using legacy multi-story path`);
      }
      content = await generateNewsScript(articles, config.content);
    }
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

  // Get word-level timestamps via whisper.cpp (Step 6)
  const subCfg = config.video.subtitles ?? {};
  const words = await getWordTimestamps(combinedAudioPath, outputDir, {
    modelPath: subCfg.modelPath,
    bin: subCfg.bin,
  });

  await discord.status(
    `✅ **Stage 3/4 complete**: ${audioSegments.length} audio segments (${Math.floor(totalDur / 60)}m ${Math.floor(totalDur % 60)}s), ${words.length} word timestamps`,
  );

  if (shouldStop("slides", opts.stopAtStage)) {
    console.log(`\nStopped after TTS. Output: ${outputDir}`);
    return { outputDir, content, audioSegments, words };
  }

  // ── Stage 4: Render Video ──
  const engine: VideoEngine = config.video.engine ?? "remotion";
  emit("video", "started", `Rendering video with ${engine}...`);
  await discord.status(`🎬 **Stage 4/4**: Rendering video (engine: ${engine})...`);

  const fps = config.video.fps ?? 30;
  let videoResult: {
    landscapePath: string;
    portraitPath: string;
    durationSeconds: number;
    subtitlePath: string;
  };

  // Pexels needs an API key — if it's missing at startup, transparently
  // downgrade to Remotion so the user always gets a real video out of the box.
  const pexelsKeyEnv = config.video.pexels?.apiKeyEnv ?? "PEXELS_API_KEY";
  const pexelsKeyAvailable = !!process.env[pexelsKeyEnv];
  let effectiveEngine: VideoEngine = engine;
  if (engine === "pexels" && !pexelsKeyAvailable) {
    console.warn(
      `  ⚠ ${pexelsKeyEnv} not set — falling back to Remotion engine. Get a free key at https://www.pexels.com/api/`,
    );
    await discord.status(
      `⚠ ${pexelsKeyEnv} missing — using Remotion engine. Add the key to .env and re-run for B-roll videos.`,
    );
    effectiveEngine = "remotion";
  }

  if (effectiveEngine === "pexels") {
    // ── Pexels B-roll Path (Step 6, free, no GPU) ──
    // 1. Fetch + trim per-slide Pexels clips
    // 2. Copy clips into Remotion's public/ dir (for staticFile() access)
    // 3. Hand them to renderWithRemotion via brollPaths — Remotion's bundled
    //    Chrome+ffmpeg renders the b-roll as full-bleed background with the
    //    title chip + word captions on top. No fragile shell-side text filters.
    try {
      const broll = await generateBrollClips(
        content.slides,
        audioSegments,
        outputDir,
        config.video,
        concept,
      );

      const ok = broll.clipPaths.filter(Boolean).length;
      console.log(`  ✓ B-roll: ${ok}/${broll.clipPaths.length} clips fetched`);

      if (ok < Math.ceil(broll.clipPaths.length / 2)) {
        throw new Error(
          `only ${ok}/${broll.clipPaths.length} B-roll clips fetched — falling back to Remotion`,
        );
      }

      // Copy each clip into public/broll/ so Remotion's staticFile() can find it
      const publicDir = join(__dirname, "..", "public");
      const publicBrollDir = join(publicDir, "broll");
      const { mkdirSync, copyFileSync } = await import("node:fs");
      mkdirSync(publicBrollDir, { recursive: true });
      const brollPaths: string[] = [];
      for (let i = 0; i < broll.clipPaths.length; i++) {
        const src = broll.clipPaths[i];
        if (src && existsSync(src)) {
          const idx = String(i + 1).padStart(2, "0");
          const publicName = `broll/clip_${idx}.mp4`;
          copyFileSync(src, join(publicDir, publicName));
          brollPaths.push(publicName);
        } else {
          brollPaths.push(""); // empty → Remotion falls back to slide component
        }
      }

      const fb = await renderWithRemotion(
        content,
        audioSegments,
        combinedAudioPath,
        words,
        outputDir,
        fps,
        config,
        opts,
        emit,
        brollPaths,
      );
      if (!fb) return { outputDir, content, audioSegments };
      videoResult = fb;
    } catch (err) {
      console.error(`  ❌ Pexels B-roll engine failed: ${(err as Error).message}`);
      await discord.status(
        `⚠ Pexels engine failed, falling back to Remotion: ${(err as Error).message.slice(0, 100)}`,
      );
      const fb = await renderWithRemotion(
        content,
        audioSegments,
        combinedAudioPath,
        words,
        outputDir,
        fps,
        config,
        opts,
        emit,
      );
      if (!fb) return { outputDir, content, audioSegments };
      videoResult = fb;
    }
  } else if (
    effectiveEngine === "ltx" ||
    effectiveEngine === "wan2gp" ||
    effectiveEngine === "hybrid" ||
    effectiveEngine === "cloud"
  ) {
    // ── AI Video Generation Path (LTX-Video; legacy "wan2gp"/"cloud" alias to LTX) ──
    try {
      // Step 1: Optimize prompts (convert slide content → cinematic video prompts)
      console.log("  🧠 Optimizing video prompts with LLM...");
      const videoPrompts =
        config.video.optimizePrompts !== false
          ? await optimizePrompts(content.slides, config.content)
          : content.slides.map(
              (s) =>
                `Cinematic shot of ${s.title}, futuristic technology aesthetic, dramatic lighting, 4K`,
            );

      await writeFile(join(outputDir, "video-prompts.json"), JSON.stringify(videoPrompts, null, 2));
      console.log(`  ✓ ${videoPrompts.length} video prompts ready`);

      // Step 2: For hybrid mode, render Remotion slides as reference images
      let referenceImages: string[] | undefined;
      if (effectiveEngine === "hybrid") {
        console.log("  🖼️ Rendering reference slides for hybrid mode...");
        const slidesDir = join(outputDir, "slides");
        await mkdir(slidesDir, { recursive: true });

        const slidesWithFrames = content.slides.map((slide, i) => ({
          ...slide,
          durationFrames: Math.max(60, Math.ceil((audioSegments[i]?.durationSeconds ?? 5) * fps)),
        }));

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
          const tempVideoPath = join(outputDir, "temp_remotion.mp4");
          await renderVideo(
            {
              slides: slidesWithFrames,
              audioPath: existsSync(combinedAudioPath) ? publicAudioName : "",
              words,
              fps,
            },
            tempVideoPath,
            () => {},
          );

          // Extract first frame from each slide's segment as reference image
          const { exec: execCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(execCb);

          referenceImages = [];
          let frameOffset = 0;
          for (let i = 0; i < slidesWithFrames.length; i++) {
            const imgPath = join(slidesDir, `slide_${String(i + 1).padStart(2, "0")}.png`);
            const timeOffset = frameOffset / fps;
            try {
              await execAsync(
                `ffmpeg -y -ss ${timeOffset} -i "${tempVideoPath}" -frames:v 1 "${imgPath}"`,
              );
              referenceImages.push(existsSync(imgPath) ? imgPath : "");
            } catch {
              referenceImages.push("");
            }
            frameOffset += slidesWithFrames[i].durationFrames;
          }

          // Clean up temp video
          const { unlink } = await import("node:fs/promises");
          await unlink(tempVideoPath).catch(() => {});

          console.log(`  ✓ ${referenceImages.filter(Boolean).length} reference images extracted`);
        } catch (err) {
          console.warn(
            `  ⚠ Reference image extraction failed: ${(err as Error).message.slice(0, 100)}`,
          );
          console.warn("  Falling back to text-to-video only");
          referenceImages = undefined;
        }
      }

      // Step 3: Generate AI video clips
      const aiResult = await generateAiVideoClips(
        videoPrompts,
        outputDir,
        config.video,
        referenceImages,
      );

      const cached = aiResult.fromCache.filter(Boolean).length;
      const generated = aiResult.clipPaths.filter(Boolean).length;
      const failed = aiResult.clipPaths.filter((p) => !p).length;
      console.log(`  ✓ Clips: ${generated} generated (${cached} cached), ${failed} failed`);

      // Step 4: Fallback — for any failed clips, try Remotion for that slide
      if (failed > 0 && engine !== "cloud") {
        console.log(`  🔄 Generating ${failed} fallback clip(s) with Remotion...`);
        // For failed clips, create a static image from Remotion as placeholder
        for (let i = 0; i < aiResult.clipPaths.length; i++) {
          if (aiResult.clipPaths[i]) continue;
          // Generate a simple static clip from slide content
          const fallbackPath = join(outputDir, `fallback_${String(i + 1).padStart(2, "0")}.mp4`);
          const dur = audioSegments[i]?.durationSeconds ?? config.video.durationPerSlide;
          const { exec: execCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFb = promisify(execCb);
          try {
            // Generate a dark gradient clip with the slide title as fallback
            await execFb(
              `ffmpeg -y -f lavfi -i "color=c=#1a1a2e:s=1920x1080:r=${fps}" ` +
                `-t ${dur} -c:v libx264 -pix_fmt yuv420p "${fallbackPath}"`,
              { timeout: 60_000 },
            );
            if (existsSync(fallbackPath)) {
              aiResult.clipPaths[i] = fallbackPath;
              aiResult.durations[i] = dur;
            }
          } catch {
            console.warn(`  ⚠ Fallback clip ${i + 1} also failed`);
          }
        }
      }

      // Step 5: Compose clips with TTS audio
      const composed = await composeAiVideo(
        aiResult.clipPaths,
        audioSegments.map((a) => ({
          audioPath: a.audioPath,
          durationSeconds: a.durationSeconds,
        })),
        outputDir,
        fps,
      );

      videoResult = {
        landscapePath: composed.landscapePath,
        portraitPath: composed.portraitPath,
        durationSeconds: composed.durationSeconds,
        subtitlePath: join(outputDir, "word-timestamps.json"),
      };
    } catch (err) {
      console.error(`  ❌ AI video generation failed: ${(err as Error).message}`);
      await discord.status(
        `⚠ AI video failed, falling back to Remotion: ${(err as Error).message.slice(0, 120)}`,
      );
      // Fall through to Remotion as ultimate fallback
      return await renderWithRemotion(
        content,
        audioSegments,
        combinedAudioPath,
        words,
        outputDir,
        fps,
        config,
        opts,
        emit,
      );
    }
  } else {
    // ── Remotion Path (default) ──
    const remotionResult = await renderWithRemotion(
      content,
      audioSegments,
      combinedAudioPath,
      words,
      outputDir,
      fps,
      config,
      opts,
      emit,
    );
    if (!remotionResult) return { outputDir, content, audioSegments };
    videoResult = remotionResult;
  }

  const videoDuration = videoResult.durationSeconds;
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

/**
 * Render video using Remotion (original pipeline).
 * Extracted as a helper so AI engines can fall back to it on failure.
 */
async function renderWithRemotion(
  content: VideoContent,
  audioSegments: Array<{ audioPath: string; srtPath: string; durationSeconds: number }>,
  combinedAudioPath: string,
  words: Array<{ word: string; start: number; end: number }>,
  outputDir: string,
  fps: number,
  config: PipelineConfig,
  opts: RunOptions,
  emit: (stage: Stage, status: string, message: string) => void,
  brollPaths?: string[],
): Promise<{
  landscapePath: string;
  portraitPath: string;
  durationSeconds: number;
  subtitlePath: string;
} | null> {
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
        brollPaths,
      },
      videoLandscapePath,
      (pct) => {
        if (pct % 25 === 0) console.log(`  Rendering: ${pct}%`);
      },
    );
  } catch (err) {
    console.error(`  ❌ Remotion render failed: ${(err as Error).message}`);
    await discord.status(`❌ Remotion render failed: ${(err as Error).message.slice(0, 100)}`);
    return null;
  }

  // Get video duration
  const { exec: execCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execCb);
  const totalDur = audioSegments.reduce((s, a) => s + a.durationSeconds, 0);
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

  return {
    landscapePath: videoLandscapePath,
    portraitPath: videoPortraitPath,
    durationSeconds: videoDuration,
    subtitlePath: join(outputDir, "word-timestamps.json"),
  };
}
