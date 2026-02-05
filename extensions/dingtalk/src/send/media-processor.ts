/**
 * Media Processor for DingTalk.
 * Handles local image paths in Markdown content by uploading them
 * and replacing with media IDs or public URLs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedDingTalkAccount } from "../accounts.js";
import type { TokenManager } from "../api/token-manager.js";
import type { StreamLogger } from "../stream/types.js";
import {
  isLocalPath,
  normalizeLocalPath,
  uploadMediaToOAPI,
  detectMediaType,
} from "../api/media-upload.js";

/**
 * Regular expression to match Markdown images with local paths.
 *
 * Matches patterns like:
 * - ![alt](/tmp/image.png)
 * - ![alt](file:///tmp/image.png)
 * - ![alt](MEDIA:/tmp/image.png)
 * - ![alt](attachment:///tmp/image.png)
 * - ![alt](/Users/xxx/image.jpg)
 * - ![alt](/home/xxx/image.jpg)
 * - ![alt](C:\Users\xxx\image.png) (Windows)
 * - ![alt](/private/var/folders/xxx/image.png) (macOS temp)
 */
const LOCAL_IMAGE_REGEX =
  /!\[([^\]]*)\]\(((?:file:\/\/\/|MEDIA:|attachment:\/\/\/)?(?:\/(?:tmp|var|private|Users|home|root|opt|data)[^\s)]*|[A-Za-z]:[\\/][^\s)]+|~[^\s)]*))\)/g;

/**
 * Result of processing local images in Markdown.
 */
export interface ProcessImagesResult {
  text: string;
  processedCount: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Process local image paths in Markdown content.
 *
 * Finds all local image paths, uploads them to DingTalk, and replaces
 * the paths with media IDs that can be used in messages.
 *
 * Note: DingTalk Markdown in sessionWebhook doesn't support media_id directly
 * in image syntax. This function is primarily for extracting and sending
 * images separately, or for use with proactive API.
 */
export async function processLocalImagesInMarkdown(opts: {
  text: string;
  account: ResolvedDingTalkAccount;
  tokenManager: TokenManager;
  logger?: StreamLogger;
  cache?: Map<string, string>;
}): Promise<ProcessImagesResult> {
  const { text, account, tokenManager, logger, cache = new Map() } = opts;

  let result = text;
  let processedCount = 0;
  const errors: Array<{ path: string; error: string }> = [];

  // Find all local image matches
  const matches = [...text.matchAll(LOCAL_IMAGE_REGEX)];

  if (matches.length === 0) {
    return { text, processedCount: 0, errors: [] };
  }

  logger?.debug?.(
    { matchCount: matches.length },
    "Found local images in Markdown"
  );

  for (const match of matches) {
    const [fullMatch, alt, rawPath] = match;

    // Skip if not actually a local path
    if (!isLocalPath(rawPath)) {
      continue;
    }

    const localPath = normalizeLocalPath(rawPath);

    // Check if file exists
    if (!fs.existsSync(localPath)) {
      logger?.warn?.(
        { path: localPath },
        "Local image file not found, skipping"
      );
      errors.push({ path: localPath, error: "File not found" });
      continue;
    }

    // Check if we have a cached mediaId
    let mediaId = cache.get(localPath);

    if (!mediaId) {
      // Upload the file
      try {
        const fileBuffer = fs.readFileSync(localPath);
        const fileName = path.basename(localPath);

        const uploadResult = await uploadMediaToOAPI({
          account,
          media: fileBuffer,
          fileName,
          mediaType: detectMediaType(fileName),
          tokenManager,
          logger,
        });

        if (!uploadResult.ok || !uploadResult.mediaId) {
          logger?.error?.(
            { path: localPath, error: uploadResult.error?.message },
            "Failed to upload local image"
          );
          errors.push({
            path: localPath,
            error: uploadResult.error?.message ?? "Upload failed",
          });
          continue;
        }

        mediaId = uploadResult.mediaId;
        cache.set(localPath, mediaId);

        logger?.debug?.(
          { path: localPath, mediaId },
          "Uploaded local image"
        );
      } catch (err) {
        const error = err as Error;
        logger?.error?.(
          { path: localPath, err: { message: error?.message } },
          "Error uploading local image"
        );
        errors.push({ path: localPath, error: error?.message ?? "Upload error" });
        continue;
      }
    }

    // Replace the local path with mediaId
    // Note: DingTalk Markdown may not render this correctly, but we replace it anyway
    // The calling code should handle extracting images and sending them separately
    result = result.replace(fullMatch, `![${alt}](dingtalk-media:${mediaId})`);
    processedCount++;
  }

  return { text: result, processedCount, errors };
}

/**
 * Extract local image paths from Markdown content.
 * Returns an array of local file paths found in the text.
 */
export function extractLocalImagePaths(text: string): string[] {
  const paths: string[] = [];
  const matches = [...text.matchAll(LOCAL_IMAGE_REGEX)];

  for (const match of matches) {
    const rawPath = match[2];
    if (isLocalPath(rawPath)) {
      paths.push(normalizeLocalPath(rawPath));
    }
  }

  return paths;
}

/**
 * Remove local image Markdown syntax from text.
 * Useful when images are sent separately.
 */
export function stripLocalImages(text: string): string {
  return text.replace(LOCAL_IMAGE_REGEX, (match, _alt, rawPath) => {
    if (isLocalPath(rawPath)) {
      // Remove the entire image markdown
      return "";
    }
    return match;
  }).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Process media content for DingTalk sending.
 *
 * This is a high-level function that:
 * 1. Extracts local images from Markdown
 * 2. Uploads them to DingTalk
 * 3. Returns the mediaIds for separate sending
 * 4. Returns cleaned text with local images removed
 */
export async function prepareMediaContent(opts: {
  text: string;
  account: ResolvedDingTalkAccount;
  tokenManager: TokenManager;
  logger?: StreamLogger;
}): Promise<{
  text: string;
  mediaIds: Array<{ mediaId: string; fileName: string }>;
  errors: Array<{ path: string; error: string }>;
}> {
  const { text, account, tokenManager, logger } = opts;

  const localPaths = extractLocalImagePaths(text);
  const mediaIds: Array<{ mediaId: string; fileName: string }> = [];
  const errors: Array<{ path: string; error: string }> = [];

  if (localPaths.length === 0) {
    return { text, mediaIds: [], errors: [] };
  }

  logger?.debug?.(
    { count: localPaths.length },
    "Preparing media content"
  );

  // Upload each local image
  for (const localPath of localPaths) {
    if (!fs.existsSync(localPath)) {
      logger?.warn?.({ path: localPath }, "Local file not found");
      errors.push({ path: localPath, error: "File not found" });
      continue;
    }

    try {
      const fileBuffer = fs.readFileSync(localPath);
      const fileName = path.basename(localPath);

      const uploadResult = await uploadMediaToOAPI({
        account,
        media: fileBuffer,
        fileName,
        mediaType: detectMediaType(fileName),
        tokenManager,
        logger,
      });

      if (uploadResult.ok && uploadResult.mediaId) {
        mediaIds.push({ mediaId: uploadResult.mediaId, fileName });
        logger?.debug?.({ path: localPath, mediaId: uploadResult.mediaId }, "Media uploaded");
      } else {
        errors.push({
          path: localPath,
          error: uploadResult.error?.message ?? "Upload failed",
        });
      }
    } catch (err) {
      const error = err as Error;
      errors.push({ path: localPath, error: error?.message ?? "Error" });
    }
  }

  // Remove local images from text
  const cleanedText = stripLocalImages(text);

  return { text: cleanedText, mediaIds, errors };
}
