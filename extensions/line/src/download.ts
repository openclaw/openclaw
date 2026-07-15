// Line plugin module implements download behavior.
import { setTimeout as delay } from "node:timers/promises";
import { messagingApi } from "@line/bot-sdk";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

// LINE prepares inbound media asynchronously: right after a message arrives the
// content endpoint answers `202 Accepted` with an empty body, and saving that body
// would persist a 0-byte file, silently dropping the user's media. Poll the content
// endpoint with capped exponential backoff until it stops reporting 202. The
// transcoding-status endpoint is not a reliable gate here: it can report "succeeded"
// while the content request still returns 202.
const CONTENT_READY_MAX_ATTEMPTS = 6;
const CONTENT_READY_BASE_DELAY_MS = 500;
const CONTENT_READY_MAX_DELAY_MS = 4000;

function contentBackoffDelayMs(attempt: number): number {
  return Math.min(CONTENT_READY_BASE_DELAY_MS * 2 ** attempt, CONTENT_READY_MAX_DELAY_MS);
}

async function fetchLineContentWhenReady(
  client: messagingApi.MessagingApiBlobClient,
  messageId: string,
): Promise<AsyncIterable<Buffer>> {
  for (let attempt = 0; attempt < CONTENT_READY_MAX_ATTEMPTS; attempt++) {
    const { httpResponse, body } = await client.getMessageContentWithHttpInfo(messageId);
    if (httpResponse.status !== 202) {
      return body as AsyncIterable<Buffer>;
    }
    // Release the empty "still preparing" response before waiting to retry.
    body.destroy();
    if (attempt < CONTENT_READY_MAX_ATTEMPTS - 1) {
      await delay(contentBackoffDelayMs(attempt));
    }
  }
  throw new Error(
    `LINE media for message ${messageId} was still preparing (HTTP 202) after ${CONTENT_READY_MAX_ATTEMPTS} attempts`,
  );
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
  options?: { originalFilename?: string },
): Promise<DownloadResult> {
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  const content = await fetchLineContentWhenReady(client, messageId);
  const saved = await saveMediaStream(
    content,
    undefined,
    "inbound",
    maxBytes,
    options?.originalFilename,
  );
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
