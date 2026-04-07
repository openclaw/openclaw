import { createReadStream, statSync } from "node:fs";
import type { VideoResult, VideoContent } from "../types.js";

const GRAPH_API = "https://graph.facebook.com/v25.0";

/**
 * Upload video to Facebook Page via Graph API chunked upload.
 * Requires: Page access token with publish_video permission.
 */
export async function uploadToFacebook(
  video: VideoResult,
  content: VideoContent,
  pageId: string,
  accessToken: string,
): Promise<string> {
  console.log("📤 Uploading to Facebook...");

  const fileSize = statSync(video.landscapePath).size;
  const uploadUrl = `${GRAPH_API}/${pageId}/videos`;

  // Phase 1: Start upload session
  const startResp = await fetch(
    `${uploadUrl}?upload_phase=start&file_size=${fileSize}&access_token=${accessToken}`,
    {
      method: "POST",
    },
  );
  const startData = (await startResp.json()) as {
    upload_session_id: string;
    start_offset: string;
    end_offset: string;
  };

  if (!startData.upload_session_id) {
    throw new Error(`Facebook upload start failed: ${JSON.stringify(startData)}`);
  }

  const sessionId = startData.upload_session_id;

  // Phase 2: Transfer chunks (5MB each)
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const { readFileSync: readFs } = await import("node:fs");
  const fileBuffer = readFs(video.landscapePath).buffer as ArrayBuffer;
  let startOffset = parseInt(startData.start_offset, 10);
  let endOffset = parseInt(startData.end_offset, 10);

  while (startOffset < fileSize) {
    const chunk = fileBuffer.slice(startOffset, Math.min(startOffset + CHUNK_SIZE, fileSize));
    const formData = new FormData();
    formData.append("video_file_chunk", new Blob([chunk]));

    const transferResp = await fetch(
      `${uploadUrl}?upload_phase=transfer&upload_session_id=${sessionId}&start_offset=${startOffset}&access_token=${accessToken}`,
      { method: "POST", body: formData },
    );
    const transferData = (await transferResp.json()) as {
      start_offset: string;
      end_offset: string;
    };
    startOffset = parseInt(transferData.start_offset, 10);
    endOffset = parseInt(transferData.end_offset, 10);
  }

  // Phase 3: Finish upload
  const finishResp = await fetch(
    `${uploadUrl}?upload_phase=finish&upload_session_id=${sessionId}&title=${encodeURIComponent(content.videoTitle)}&description=${encodeURIComponent(content.videoDescription)}&access_token=${accessToken}`,
    { method: "POST" },
  );
  const finishData = (await finishResp.json()) as { id?: string; error?: unknown };

  if (!finishData.id) {
    throw new Error(`Facebook upload finish failed: ${JSON.stringify(finishData)}`);
  }

  const url = `https://facebook.com/${pageId}/videos/${finishData.id}`;
  console.log(`  ✓ Facebook: ${url}`);
  return url;
}
