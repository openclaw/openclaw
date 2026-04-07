import { exec } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AudioSegment, VideoResult, PipelineConfig } from "../types.js";

const execAsync = promisify(exec);

function adjustSrtTimestamps(srtContent: string, offsetSeconds: number): string {
  if (!srtContent.trim()) return "";

  return srtContent.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, (_match, h, m, s, ms) => {
    const totalMs =
      (parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s)) * 1000 +
      parseInt(ms) +
      offsetSeconds * 1000;
    const newH = String(Math.floor(totalMs / 3600000)).padStart(2, "0");
    const newM = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, "0");
    const newS = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, "0");
    const newMs = String(totalMs % 1000).padStart(3, "0");
    return `${newH}:${newM}:${newS},${newMs}`;
  });
}

export async function composeVideo(
  slidePaths: string[],
  audioSegments: AudioSegment[],
  outputDir: string,
  config: PipelineConfig["video"],
): Promise<VideoResult> {
  console.log("🎬 Stage 4b: Composing video...");

  const segmentPaths: string[] = [];

  // Create per-slide video segments
  for (let i = 0; i < slidePaths.length; i++) {
    const slidePath = slidePaths[i];
    const audio = audioSegments[i];
    const idx = String(i + 1).padStart(2, "0");
    const segmentPath = join(outputDir, `segment_${idx}.mp4`);

    await execAsync(
      `ffmpeg -y -loop 1 -i "${slidePath}" -i "${audio.audioPath}" ` +
        `-c:v libx264 -tune stillimage -c:a aac -b:a 192k ` +
        `-pix_fmt yuv420p -shortest -r ${config.fps} "${segmentPath}"`,
    );

    segmentPaths.push(segmentPath);
  }

  // Create concat list
  const concatList = segmentPaths.map((p) => `file '${p}'`).join("\n");
  const concatFile = join(outputDir, "concat.txt");
  await writeFile(concatFile, concatList);

  // Concatenate all segments
  const rawPath = join(outputDir, "video_raw.mp4");
  await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${rawPath}"`);

  // Combine all SRT files with adjusted timestamps
  let combinedSrt = "";
  let subtitleIndex = 1;
  let timeOffset = 0;

  for (const segment of audioSegments) {
    const srtContent = await readFile(segment.srtPath, "utf-8").catch(() => "");
    if (srtContent.trim()) {
      const adjusted = adjustSrtTimestamps(srtContent, timeOffset);
      // Re-number subtitles
      const renumbered = adjusted.replace(/^\d+$/gm, () => String(subtitleIndex++));
      combinedSrt += renumbered + "\n";
    }
    timeOffset += segment.durationSeconds;
  }

  const subtitlePath = join(outputDir, "subtitles.srt");
  await writeFile(subtitlePath, combinedSrt);

  // Burn subtitles into landscape video
  const landscapePath = join(outputDir, "video_landscape.mp4");
  if (combinedSrt.trim()) {
    await execAsync(
      `ffmpeg -y -i "${rawPath}" -vf "subtitles='${subtitlePath}':force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H40000000&,Outline=2'" ` +
        `-c:a copy "${landscapePath}"`,
    );
  } else {
    await execAsync(`cp "${rawPath}" "${landscapePath}"`);
  }

  // Create portrait version (9:16) with blurred background
  const portraitPath = join(outputDir, "video_portrait.mp4");
  await execAsync(
    `ffmpeg -y -i "${landscapePath}" ` +
      `-vf "split[original][blur];[blur]scale=1080:1920,boxblur=20[bg];[bg][original]overlay=(W-w)/2:(H-h)/2" ` +
      `-c:a copy -r ${config.fps} "${portraitPath}"`,
  );

  const totalDuration = audioSegments.reduce((sum, s) => sum + s.durationSeconds, 0);

  // Cleanup temp segments
  for (const p of segmentPaths) {
    await execAsync(`rm -f "${p}"`).catch(() => {});
  }
  await execAsync(`rm -f "${rawPath}" "${concatFile}"`).catch(() => {});

  console.log(`  ✓ Landscape: video_landscape.mp4 (${config.width}x${config.height})`);
  console.log(`  ✓ Portrait: video_portrait.mp4 (1080x1920)`);
  console.log(
    `  ✓ Duration: ${Math.floor(totalDuration / 60)}m ${Math.floor(totalDuration % 60)}s\n`,
  );

  return { landscapePath, portraitPath, durationSeconds: totalDuration, subtitlePath };
}
