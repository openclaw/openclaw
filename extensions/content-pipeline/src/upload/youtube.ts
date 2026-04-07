import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { google } from "googleapis";
import type { VideoResult, VideoContent, PipelineConfig } from "../types.js";

const TOKEN_PATH = join(
  process.env.HOME ?? "~",
  ".openclaw",
  "content-pipeline",
  "youtube-token.json",
);
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

async function getAuthClient(clientSecretsPath?: string) {
  let client_id = process.env.YOUTUBE_CLIENT_ID ?? "";
  let client_secret = process.env.YOUTUBE_CLIENT_SECRET ?? "";
  let redirect_uri = "http://localhost";

  // Fallback to JSON file if env vars not set
  if (!client_id && clientSecretsPath) {
    const secrets = JSON.parse(await readFile(clientSecretsPath, "utf-8"));
    const cfg = secrets.installed ?? secrets.web;
    client_id = cfg.client_id;
    client_secret = cfg.client_secret;
    redirect_uri = cfg.redirect_uris?.[0] ?? redirect_uri;
  }

  if (!client_id || !client_secret) {
    throw new Error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env");
  }

  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

  // Check for saved token
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(await readFile(TOKEN_PATH, "utf-8"));
    oauth2.setCredentials(token);
    return oauth2;
  }

  // Interactive OAuth flow
  const authUrl = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  console.log(`  Open this URL to authorize YouTube access:\n  ${authUrl}\n`);
  console.log("  After authorization, set the code in YOUTUBE_AUTH_CODE env var and rerun.");
  console.log("  Or paste the redirect URL containing the code.");

  const code = process.env.YOUTUBE_AUTH_CODE;
  if (!code) {
    throw new Error("YouTube OAuth: no auth code provided. Set YOUTUBE_AUTH_CODE env var.");
  }

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Save token for future use
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("  ✓ YouTube token saved\n");

  return oauth2;
}

export async function uploadToYoutube(
  video: VideoResult,
  content: VideoContent,
  config: PipelineConfig["upload"]["youtube"],
  clientSecretsPath: string,
): Promise<string> {
  console.log("📤 Uploading to YouTube...");

  const auth = await getAuthClient(clientSecretsPath);
  const youtube = google.youtube({ version: "v3", auth });

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: content.videoTitle,
        description: content.videoDescription,
        tags: [...content.tags, ...config.tags],
        categoryId: config.categoryId,
      },
      status: {
        privacyStatus: config.privacy,
      },
    },
    media: {
      body: createReadStream(video.landscapePath),
    },
  });

  const videoId = response.data.id;
  const url = `https://youtube.com/watch?v=${videoId}`;
  console.log(`  ✓ YouTube: ${url}`);
  return url;
}
