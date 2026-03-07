import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

const YOUTUBE_API_BASE = "https://www.googleapis.com";
const YOUTUBE_ACCESS_TOKEN = String(process.env.YOUTUBE_ACCESS_TOKEN ?? "").trim();
const YOUTUBE_DRY_RUN = String(process.env.YOUTUBE_DRY_RUN ?? "0") === "1";

function authHeaders() {
  if (!YOUTUBE_ACCESS_TOKEN) {
    throw new Error("YOUTUBE_ACCESS_TOKEN is required for real publish");
  }
  return {
    authorization: `Bearer ${YOUTUBE_ACCESS_TOKEN}`,
  };
}

async function startResumableUpload(metadata, videoFilePath, mimeType) {
  const size = statSync(videoFilePath).size;
  const res = await fetch(`${YOUTUBE_API_BASE}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mimeType,
      "x-upload-content-length": String(size),
    },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube resumable init failed (${res.status}): ${text}`);
  }
  const uploadUrl = res.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube resumable init missing upload URL");
  return { uploadUrl, size };
}

async function uploadMedia(uploadUrl, videoFilePath, mimeType, size) {
  const stream = createReadStream(videoFilePath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": mimeType,
      "content-length": String(size),
    },
    body: stream,
    duplex: "half",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube media upload failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data;
}

async function updateVideoMetadata(payload) {
  const videoId = String(payload?.videoId ?? "").trim();
  if (!videoId) throw new Error("videoId is required for youtube metadata update");

  const snippet = {
    title: String(payload?.title ?? "Updated title"),
    description: String(payload?.description ?? ""),
    tags: Array.isArray(payload?.tags) ? payload.tags.map(String) : undefined,
    categoryId: String(payload?.categoryId ?? "22"),
  };
  const status = {
    privacyStatus: String(payload?.privacyStatus ?? "private"),
  };
  const body = { id: videoId, snippet, status };

  const res = await fetch(`${YOUTUBE_API_BASE}/youtube/v3/videos?part=snippet,status`, {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube metadata update failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function publishToYouTube(payload) {
  const action = String(payload?.action ?? "upload").toLowerCase();
  const title = String(payload?.title ?? "").trim();
  const description = String(payload?.description ?? "");
  const privacyStatus = String(payload?.privacyStatus ?? "private");
  const tags = Array.isArray(payload?.tags) ? payload.tags.map(String) : [];
  const categoryId = String(payload?.categoryId ?? "22");

  if (action === "update") {
    if (YOUTUBE_DRY_RUN) {
      return {
        provider: "YouTube",
        mode: "dry-run",
        action: "update",
        preview: { videoId: payload?.videoId, title, privacyStatus },
      };
    }
    const updated = await updateVideoMetadata(payload);
    return {
      provider: "YouTube",
      mode: "live",
      action: "update",
      videoId: updated?.id ?? payload?.videoId ?? null,
      response: updated,
    };
  }

  if (!title) throw new Error("title is required for youtube upload");
  const videoFilePath = String(payload?.videoFilePath ?? "").trim();
  if (!videoFilePath) throw new Error("videoFilePath is required for youtube upload");
  const mimeType = String(payload?.mimeType ?? "video/mp4");

  const metadata = {
    snippet: {
      title,
      description,
      tags,
      categoryId,
    },
    status: {
      privacyStatus,
    },
  };

  if (YOUTUBE_DRY_RUN) {
    return {
      provider: "YouTube",
      mode: "dry-run",
      action: "upload",
      preview: {
        file: basename(videoFilePath),
        title,
        privacyStatus,
        tags,
      },
    };
  }

  const { uploadUrl, size } = await startResumableUpload(metadata, videoFilePath, mimeType);
  const uploaded = await uploadMedia(uploadUrl, videoFilePath, mimeType, size);
  return {
    provider: "YouTube",
    mode: "live",
    action: "upload",
    videoId: uploaded?.id ?? null,
    response: uploaded,
  };
}
