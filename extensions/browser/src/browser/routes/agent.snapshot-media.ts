import path from "node:path";
import {
  ensureMediaDir,
  getImageMetadata,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import type { AnnotationItem } from "../screenshot-annotate.js";
import { scaleAnnotations } from "../screenshot-annotate.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";

export type ScreenshotCapture = {
  buffer: Buffer;
  labels?: number;
  skipped?: number;
  truncated?: boolean;
  annotations?: AnnotationItem[];
};

export async function saveBrowserMedia(buffer: Buffer, contentType: string, maxBytes: number) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(buffer, contentType, "browser", maxBytes);
  return path.resolve(saved.path);
}

export async function saveBrowserScreenshot(capture: ScreenshotCapture, type: "png" | "jpeg") {
  const normalized = await normalizeBrowserScreenshot(capture.buffer, {
    maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  });
  let annotations = capture.annotations;
  const originalBuffer = capture.buffer;
  if (annotations?.length) {
    const orig = normalized.sourceDimensions;
    // Preserve coordinates when dimensions are unavailable or identical bytes cannot rescale boxes.
    if (originalBuffer !== normalized.buffer && orig?.width && orig?.height) {
      const next = await getImageMetadata(normalized.buffer);
      if (
        next?.width &&
        next?.height &&
        (next.width !== orig.width || next.height !== orig.height)
      ) {
        annotations = scaleAnnotations(
          annotations,
          next.width / orig.width,
          next.height / orig.height,
        );
      }
    }
  }
  const imagePath = await saveBrowserMedia(
    normalized.buffer,
    normalized.contentType ?? `image/${type}`,
    DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  );
  return {
    imagePath,
    imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : type,
    ...(typeof capture.labels === "number" ? { labels: true, labelsCount: capture.labels } : {}),
    ...(typeof capture.skipped === "number" ? { labelsSkipped: capture.skipped } : {}),
    ...(capture.truncated ? { truncated: true } : {}),
    ...(annotations?.length ? { annotations } : {}),
  };
}
