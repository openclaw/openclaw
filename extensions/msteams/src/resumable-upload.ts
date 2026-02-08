/**
 * Resumable upload utilities for MS Teams large file support (>4MB).
 *
 * Implements Microsoft Graph's resumable upload session API.
 * @see https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession
 */

import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com";

// 4MB threshold - Graph API requires resumable upload for larger files
export const SIMPLE_UPLOAD_MAX_SIZE = 4 * 1024 * 1024;

// 5MB chunks for optimal speed/reliability balance
// Note: Graph API requires chunk size to be a multiple of 320 KiB (327,680 bytes)
// 5MB = 5,242,880 bytes = 16 * 320 KiB, which satisfies this requirement
export const CHUNK_SIZE = 5 * 1024 * 1024;

export interface UploadSession {
  uploadUrl: string;
  expirationDateTime: string;
}

export interface UploadResult {
  id: string;
  webUrl: string;
  name: string;
}

/**
 * Create a resumable upload session for large files.
 */
export async function createUploadSession(params: {
  uploadPath: string;
  filename: string;
  tokenProvider: MSTeamsAccessTokenProvider;
  driveEndpoint: string;
  fetchFn?: typeof fetch;
}): Promise<UploadSession> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = await params.tokenProvider.getAccessToken(GRAPH_SCOPE);

  // URL encode the path to handle special characters (spaces, #, %, etc.)
  const encodedPath = params.uploadPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const res = await fetchFn(
    `${GRAPH_ROOT}${params.driveEndpoint}/root:${encodedPath}:/createUploadSession`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: params.filename,
        },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Create upload session failed: ${res.status} - ${body}`);
  }

  const data = (await res.json()) as { uploadUrl?: string; expirationDateTime?: string };
  if (!data.uploadUrl) {
    throw new Error("Missing uploadUrl in response");
  }

  return { uploadUrl: data.uploadUrl, expirationDateTime: data.expirationDateTime ?? "" };
}

/**
 * Upload file in chunks using resumable session.
 * Handles intermediate 202 Accepted responses per Graph API spec.
 */
export async function uploadInChunks(params: {
  buffer: Buffer;
  uploadSession: UploadSession;
  fetchFn?: typeof fetch;
  onProgress?: (uploaded: number, total: number) => void;
}): Promise<UploadResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { buffer, uploadSession } = params;
  const totalSize = buffer.length;
  let offset = 0;

  while (offset < totalSize) {
    const chunkEnd = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunk = buffer.subarray(offset, chunkEnd);

    const res = await fetchFn(uploadSession.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${offset}-${chunkEnd - 1}/${totalSize}`,
      },
      body: new Uint8Array(chunk),
    });

    if (!res.ok && res.status !== 202) {
      const body = await res.text().catch(() => "");
      throw new Error(`Upload chunk failed: ${res.status} - ${body}`);
    }

    params.onProgress?.(chunkEnd, totalSize);

    // 200/201 indicates upload complete with driveItem in response
    // 202 indicates chunk accepted but upload not complete
    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { id?: string; webUrl?: string; name?: string };
      if (!data.id || !data.webUrl || !data.name) {
        throw new Error("Upload response missing required fields");
      }
      return { id: data.id, webUrl: data.webUrl, name: data.name };
    }

    // For 202, parse response to get next expected range if available
    if (res.status === 202) {
      const data = (await res.json()) as { nextExpectedRanges?: string[] };
      if (data.nextExpectedRanges && data.nextExpectedRanges.length > 0) {
        // Parse next expected range (format: "start-end" or "start-")
        const nextRange = data.nextExpectedRanges[0];
        const nextStart = parseInt(nextRange.split("-")[0], 10);
        if (!isNaN(nextStart)) {
          offset = nextStart;
          continue;
        }
      }
    }

    offset = chunkEnd;
  }

  throw new Error("Upload completed but no final response received");
}
