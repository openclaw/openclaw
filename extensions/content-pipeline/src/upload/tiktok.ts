import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { VideoResult, VideoContent } from "../types.js";

const execAsync = promisify(exec);

/**
 * Upload to TikTok via the tiktok-uploader Python CLI.
 * Requires: pip install tiktok-uploader
 * Requires: cookies file from manual TikTok login
 */
export async function uploadToTiktok(
  video: VideoResult,
  content: VideoContent,
  cookiesPath: string,
): Promise<string> {
  console.log("📤 Uploading to TikTok...");

  const description = [
    content.videoTitle,
    "",
    ...content.tags.slice(0, 5).map((t) => `#${t.replace(/\s+/g, "")}`),
    "#tech #programming #coding",
  ].join(" ");

  try {
    // Use tiktok-uploader CLI
    await execAsync(
      `python3 -m tiktok_uploader.upload ` +
        `--video "${video.portraitPath}" ` +
        `--description "${description.replace(/"/g, '\\"')}" ` +
        `--cookies "${cookiesPath}" ` +
        `--headless`,
      { timeout: 120_000 },
    );

    console.log("  ✓ TikTok: uploaded");
    return "uploaded";
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`  ✗ TikTok: ${msg}`);
    throw new Error(`TikTok upload failed: ${msg}`);
  }
}
