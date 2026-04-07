/**
 * Discord approval flow with buttons + reply commands.
 *
 * After video is ready:
 * 1. Bot posts preview to #published-news with Approve/Reject buttons
 * 2. User clicks Approve → uploads to YouTube/TikTok/Facebook
 * 3. User clicks Reject → asks for feedback
 *
 * Also supports reply commands: "approve" / "reject"
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://discord.com/api/v10";
const getToken = () => process.env.DISCORD_BOT_TOKEN ?? "";

const CHANNELS = {
  publishedNews: "1490932855453515898",
  publishedTutorials: "1490932862386442240",
  teamStatus: "1490891176272986308",
};

export interface ApprovalRequest {
  runId: string;
  outputDir: string;
  videoTitle: string;
  duration: string;
  slideCount: number;
  r2Urls: Record<string, string>;
  pipelineType: "news" | "tutorial";
}

// Store pending approvals in memory
const pendingApprovals = new Map<string, ApprovalRequest>();

/**
 * Post video preview with Approve/Reject buttons to Discord.
 * Returns the message ID for tracking.
 */
export async function requestApproval(req: ApprovalRequest): Promise<string | null> {
  const token = getToken();
  if (!token) return null;

  const channelId =
    req.pipelineType === "news" ? CHANNELS.publishedNews : CHANNELS.publishedTutorials;

  const videoUrl = req.r2Urls["video_landscape.mp4"] ?? "";
  const slideUrls = Object.entries(req.r2Urls)
    .filter(([k]) => k.startsWith("slide_"))
    .map(([k, v]) => `[${k}](${v})`)
    .join(" | ");

  const body = {
    content: [
      `📹 **Video Ready for Review**`,
      ``,
      `🎬 **${req.videoTitle}**`,
      `⏱️ Duration: ${req.duration}`,
      `📊 ${req.slideCount} slides`,
      videoUrl ? `🔗 Preview: ${videoUrl}` : "",
      slideUrls ? `🖼️ Slides: ${slideUrls}` : "",
      ``,
      `**Click a button or reply with \`approve\` or \`reject\`**`,
    ]
      .filter(Boolean)
      .join("\n"),
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 3, // Green (Success)
            label: "✅ Approve & Publish",
            custom_id: `approve:${req.runId}`,
          },
          {
            type: 2,
            style: 4, // Red (Danger)
            label: "❌ Reject",
            custom_id: `reject:${req.runId}`,
          },
        ],
      },
    ],
  };

  const resp = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.warn(`  Discord approval post failed: ${resp.status}`);
    return null;
  }

  const msg = (await resp.json()) as { id: string };
  pendingApprovals.set(req.runId, req);

  // Also save approval request to disk for persistence across restarts
  const approvalFile = join(req.outputDir, "approval.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    approvalFile,
    JSON.stringify({ ...req, messageId: msg.id, status: "pending" }, null, 2),
  );

  console.log(`  🔔 Approval requested in Discord (message: ${msg.id})`);
  return msg.id;
}

/**
 * Handle approval — upload to all platforms.
 */
export async function handleApproval(runId: string): Promise<Record<string, string>> {
  const req = pendingApprovals.get(runId);
  if (!req) {
    // Try loading from disk
    console.warn(`  No pending approval found for ${runId}`);
    return {};
  }

  const results: Record<string, string> = {};

  await postToChannel(
    CHANNELS.teamStatus,
    `📤 **Publishing "${req.videoTitle}"** to all platforms...`,
  );

  // YouTube
  try {
    const { uploadToYoutube } = await import("./upload/youtube.js");
    const { loadConfig } = await import("./pipeline.js");
    const config = loadConfig();
    const videoResult = {
      landscapePath: join(req.outputDir, "video_landscape.mp4"),
      portraitPath: join(req.outputDir, "video_portrait.mp4"),
      durationSeconds: 0,
      subtitlePath: join(req.outputDir, "subtitles.srt"),
    };
    const content = JSON.parse(readFileSync(join(req.outputDir, "script.json"), "utf-8"));

    if (existsSync(videoResult.landscapePath)) {
      const clientSecrets = process.env.YOUTUBE_CLIENT_SECRETS ?? "client_secrets.json";
      const url = await uploadToYoutube(videoResult, content, config.upload.youtube, clientSecrets);
      results.youtube = url;
      await postToChannel(CHANNELS.teamStatus, `  ✅ YouTube: ${url}`);
    }
  } catch (err) {
    results.youtube = `error: ${(err as Error).message.slice(0, 100)}`;
    await postToChannel(
      CHANNELS.teamStatus,
      `  ❌ YouTube failed: ${(err as Error).message.slice(0, 100)}`,
    );
  }

  // Facebook — upload video directly to Page via graph-video.facebook.com
  try {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (pageId && pageToken) {
      const content = JSON.parse(readFileSync(join(req.outputDir, "script.json"), "utf-8"));
      const videoPath = join(req.outputDir, "video_landscape.mp4");

      if (existsSync(videoPath)) {
        const { readFileSync: rfs } = await import("node:fs");
        const videoData = rfs(videoPath);
        const description = `${content.videoDescription ?? ""}\n\n${content.tags?.map((t: string) => `#${t.replace(/\s+/g, "")}`).join(" ") ?? ""}`;

        const formData = new FormData();
        formData.append("access_token", pageToken);
        formData.append("title", content.videoTitle);
        formData.append("description", description);
        formData.append("source", new Blob([videoData]), "video.mp4");

        const resp = await fetch(`https://graph-video.facebook.com/v25.0/${pageId}/videos`, {
          method: "POST",
          body: formData,
        });

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(err.slice(0, 100));
        }

        const data = (await resp.json()) as { id?: string };
        const fbUrl = `https://facebook.com/${pageId}/videos/${data.id}`;
        results.facebook = fbUrl;
        await postToChannel(CHANNELS.teamStatus, `  ✅ Facebook: ${fbUrl}`);
      }
    }
  } catch (err) {
    results.facebook = `error: ${(err as Error).message.slice(0, 100)}`;
    await postToChannel(
      CHANNELS.teamStatus,
      `  ❌ Facebook failed: ${(err as Error).message.slice(0, 100)}`,
    );
  }

  // TikTok
  try {
    const cookiesPath = process.env.TIKTOK_COOKIES_PATH;
    if (cookiesPath && existsSync(cookiesPath)) {
      const { uploadToTiktok } = await import("./upload/tiktok.js");
      const content = JSON.parse(readFileSync(join(req.outputDir, "script.json"), "utf-8"));
      const videoResult = {
        landscapePath: join(req.outputDir, "video_landscape.mp4"),
        portraitPath: join(req.outputDir, "video_portrait.mp4"),
        durationSeconds: 0,
        subtitlePath: "",
      };
      if (existsSync(videoResult.portraitPath)) {
        await uploadToTiktok(videoResult, content, cookiesPath);
        results.tiktok = "uploaded";
        await postToChannel(CHANNELS.teamStatus, `  ✅ TikTok: uploaded`);
      }
    } else {
      results.tiktok = "skipped (no cookies)";
    }
  } catch (err) {
    results.tiktok = `error: ${(err as Error).message.slice(0, 100)}`;
    await postToChannel(
      CHANNELS.teamStatus,
      `  ❌ TikTok failed: ${(err as Error).message.slice(0, 100)}`,
    );
  }

  // Post final results
  const channelId =
    req.pipelineType === "news" ? CHANNELS.publishedNews : CHANNELS.publishedTutorials;
  const lines = Object.entries(results)
    .map(([platform, result]) =>
      result.startsWith("error")
        ? `❌ ${platform}: ${result}`
        : result.startsWith("http")
          ? `✅ ${platform}: ${result}`
          : `✅ ${platform}: ${result}`,
    )
    .join("\n");

  await postToChannel(channelId, `🎉 **Published: "${req.videoTitle}"**\n\n${lines}`);
  await postToChannel(CHANNELS.teamStatus, `🎉 **Published!** "${req.videoTitle}"\n${lines}`);

  pendingApprovals.delete(runId);

  // Update approval file
  try {
    const approvalFile = join(req.outputDir, "approval.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(approvalFile, JSON.stringify({ ...req, status: "approved", results }, null, 2));
  } catch {}

  return results;
}

/**
 * Handle rejection.
 */
export async function handleRejection(runId: string, reason?: string): Promise<void> {
  const req = pendingApprovals.get(runId);

  await postToChannel(
    CHANNELS.teamStatus,
    `❌ **Rejected:** "${req?.videoTitle ?? runId}"${reason ? `\n💬 Reason: ${reason}` : ""}\nVideo will not be published.`,
  );

  pendingApprovals.delete(runId);

  if (req) {
    try {
      const approvalFile = join(req.outputDir, "approval.json");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(approvalFile, JSON.stringify({ ...req, status: "rejected", reason }, null, 2));
    } catch {}
  }
}

/** Get pending approval by runId */
export function getPendingApproval(runId: string): ApprovalRequest | undefined {
  return pendingApprovals.get(runId);
}

/** Get all pending approvals */
export function getAllPendingApprovals(): Map<string, ApprovalRequest> {
  return pendingApprovals;
}

async function postToChannel(channelId: string, content: string): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
  } catch {}
}
