// Feishu outbound video preview cover helpers.
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { raceWithTimeoutAndAbort } from "./async.js";

export const FEISHU_VIDEO_PREVIEW_TIMEOUT_MS = 5_000;

const FEISHU_VIDEO_PREVIEW_FILE_NAME = "preview.jpg";
const FEISHU_VIDEO_PREVIEW_SEEK_SECONDS = "0.5";
const FEISHU_VIDEO_PREVIEW_MAX_WIDTH = 1280;
const FEISHU_VIDEO_PREVIEW_MAX_HEIGHT = 720;

function inferVideoPreviewInputExtension(params: {
  fileName: string;
  contentType?: string;
}): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
  if (ext && ext.length <= 12) {
    return ext;
  }

  switch (normalizeLowercaseStringOrEmpty(params.contentType)) {
    case "video/quicktime":
      return ".mov";
    case "video/x-msvideo":
      return ".avi";
    default:
      return ".mp4";
  }
}

async function renderFeishuVideoPreviewFrame(params: {
  buffer: Buffer;
  fileName: string;
  contentType?: string;
  maxBytes: number;
}): Promise<Buffer | undefined> {
  try {
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "feishu-video-preview-" },
      async (workspace) => {
        const inputPath = await workspace.write(
          `input${inferVideoPreviewInputExtension(params)}`,
          params.buffer,
        );
        await writeExternalFileWithinRoot({
          rootDir: workspace.dir,
          path: FEISHU_VIDEO_PREVIEW_FILE_NAME,
          write: async (outputPath) => {
            await runFfmpeg(
              [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                FEISHU_VIDEO_PREVIEW_SEEK_SECONDS,
                "-i",
                inputPath,
                "-vf",
                `scale=${String(FEISHU_VIDEO_PREVIEW_MAX_WIDTH)}:${String(FEISHU_VIDEO_PREVIEW_MAX_HEIGHT)}:force_original_aspect_ratio=decrease`,
                "-frames:v",
                "1",
                "-c:v",
                "mjpeg",
                "-q:v",
                "3",
                "-f",
                "image2",
                "-fs",
                String(params.maxBytes + 1),
                outputPath,
              ],
              { timeoutMs: FEISHU_VIDEO_PREVIEW_TIMEOUT_MS },
            );
          },
        });
        const previewStat = await fs.promises.stat(workspace.path(FEISHU_VIDEO_PREVIEW_FILE_NAME));
        if (!previewStat.isFile() || previewStat.size === 0 || previewStat.size > params.maxBytes) {
          throw new Error("Feishu video preview exceeds its image upload limit");
        }
        return await workspace.read(FEISHU_VIDEO_PREVIEW_FILE_NAME);
      },
    );
  } catch (err) {
    console.warn("[feishu] failed to render video preview; sending video without cover:", err);
    return undefined;
  }
}

export async function maybeUploadVideoPreviewImageKey(params: {
  buffer: Buffer;
  fileName: string;
  contentType?: string;
  msgType: "file" | "audio" | "media";
  maxBytes: number;
  uploadImage: (image: Buffer) => Promise<string>;
}): Promise<string | undefined> {
  if (params.msgType !== "media") {
    return undefined;
  }

  const preview = await renderFeishuVideoPreviewFrame(params);
  if (!preview) {
    return undefined;
  }

  try {
    const result = await raceWithTimeoutAndAbort(params.uploadImage(preview), {
      timeoutMs: FEISHU_VIDEO_PREVIEW_TIMEOUT_MS,
    });
    if (result.status !== "resolved") {
      console.warn("[feishu] video preview upload timed out; sending video without cover");
      return undefined;
    }
    return result.value;
  } catch (err) {
    console.warn("[feishu] failed to upload video preview; sending video without cover:", err);
    return undefined;
  }
}
