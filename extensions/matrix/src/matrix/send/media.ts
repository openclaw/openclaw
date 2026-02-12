import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MatrixClient,
  TimedFileInfo,
  VideoFileInfo,
} from "@vector-im/matrix-bot-sdk";
import { getMatrixRuntime } from "../../runtime.js";
import { applyMatrixFormatting } from "./formatting.js";
import {
  type MatrixMediaContent,
  type MatrixMediaInfo,
  type MatrixMediaMsgType,
  type MatrixRelation,
  type MediaKind,
} from "./types.js";

const getCore = () => getMatrixRuntime();
type IFileInfo = import("music-metadata").IFileInfo;

export function buildMatrixMediaInfo(params: {
  size: number;
  mimetype?: string;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
}): MatrixMediaInfo | undefined {
  const base: FileWithThumbnailInfo = {};
  if (Number.isFinite(params.size)) {
    base.size = params.size;
  }
  if (params.mimetype) {
    base.mimetype = params.mimetype;
  }
  if (params.imageInfo) {
    const dimensional: DimensionalFileInfo = {
      ...base,
      ...params.imageInfo,
    };
    if (typeof params.durationMs === "number") {
      const videoInfo: VideoFileInfo = {
        ...dimensional,
        duration: params.durationMs,
      };
      return videoInfo;
    }
    return dimensional;
  }
  if (typeof params.durationMs === "number") {
    const timedInfo: TimedFileInfo = {
      ...base,
      duration: params.durationMs,
    };
    return timedInfo;
  }
  if (Object.keys(base).length === 0) {
    return undefined;
  }
  return base;
}

export function buildMediaContent(params: {
  msgtype: MatrixMediaMsgType;
  body: string;
  url?: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixRelation;
  isVoice?: boolean;
  durationMs?: number;
  waveform?: number[];
  imageInfo?: DimensionalFileInfo;
  file?: EncryptedFile;
}): MatrixMediaContent {
  const info = buildMatrixMediaInfo({
    size: params.size,
    mimetype: params.mimetype,
    durationMs: params.durationMs,
    imageInfo: params.imageInfo,
  });
  const base: MatrixMediaContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info: info ?? undefined,
  };
  // Encrypted media should only include the "file" payload, not top-level "url".
  if (!params.file && params.url) {
    base.url = params.url;
  }
  // For encrypted files, add the file object
  if (params.file) {
    base.file = params.file;
  }
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    if (typeof params.durationMs === "number") {
      const audioMeta: Record<string, unknown> = {
        duration: params.durationMs,
      };
      if (params.waveform && params.waveform.length > 0) {
        audioMeta.waveform = params.waveform;
      }
      base["org.matrix.msc1767.audio"] = audioMeta;
    }
  }
  if (params.relation) {
    base["m.relates_to"] = params.relation;
  }
  applyMatrixFormatting(base, params.body);
  return base;
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;

export async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getCore()
    .media.getImageMetadata(params.buffer)
    .catch(() => null);
  if (!meta) {
    return undefined;
  }
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getCore().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getCore()
        .media.getImageMetadata(thumbBuffer)
        .catch(() => null);
      const thumbUri = await params.client.uploadContent(
        thumbBuffer,
        "image/jpeg",
        "thumbnail.jpg",
      );
      imageInfo.thumbnail_url = thumbUri;
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength,
        };
      }
    } catch {
      // Thumbnail generation failed, continue without it
    }
  }
  return imageInfo;
}

export async function resolveMediaDurationMs(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind: MediaKind;
}): Promise<number | undefined> {
  if (params.kind !== "audio" && params.kind !== "video") {
    return undefined;
  }
  try {
    const { parseBuffer } = await import("music-metadata");
    const fileInfo: IFileInfo | string | undefined =
      params.contentType || params.fileName
        ? {
            mimeType: params.contentType,
            size: params.buffer.byteLength,
            path: params.fileName,
          }
        : undefined;
    const metadata = await parseBuffer(params.buffer, fileInfo, {
      duration: true,
      skipCovers: true,
    });
    const durationSeconds = metadata.format.duration;
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
      return Math.max(0, Math.round(durationSeconds * 1000));
    }
  } catch {
    // Duration is optional; ignore parse failures.
  }
  return undefined;
}

const WAVEFORM_POINTS = 100;

/** Cached result of ffmpeg availability check. `null` = not yet checked. */
let ffmpegAvailable: boolean | null = null;

async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("ffmpeg", ["-version"], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    const logger = getCore().logging.getChildLogger({ plugin: "matrix" });
    logger.warn(
      "ffmpeg not found — voice message waveform generation disabled. " +
        "Install ffmpeg to enable waveform visualizations in Element clients.",
    );
  }
  return ffmpegAvailable;
}

/**
 * Generate a waveform array (0-1024 amplitude values) from an audio buffer
 * using ffmpeg to extract PCM peaks. Returns undefined if ffmpeg is not
 * available or on failure. Used for MSC1767 voice message waveform
 * visualization in Element.
 */
export async function generateWaveform(buffer: Buffer): Promise<number[] | undefined> {
  if (!(await isFfmpegAvailable())) return undefined;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { writeFile, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomBytes } = await import("node:crypto");

    // Write buffer to temp file (ffmpeg pipe input unreliable with some formats)
    const tmpPath = join(tmpdir(), `oc-waveform-${randomBytes(6).toString("hex")}`);
    await writeFile(tmpPath, buffer);

    try {
      const { stdout } = await execFileAsync(
        "ffmpeg",
        ["-i", tmpPath, "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"],
        { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
      );

      const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
      const bucketSize = Math.max(1, Math.floor(samples.length / WAVEFORM_POINTS));
      const waveform: number[] = [];

      for (let i = 0; i < WAVEFORM_POINTS; i++) {
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, samples.length);
        let peak = 0;
        for (let j = start; j < end; j++) {
          const abs = Math.abs(samples[j]);
          if (abs > peak) peak = abs;
        }
        waveform.push(Math.min(1024, Math.round(peak * 1024)));
      }

      return waveform;
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch {
    // Waveform generation failed; voice message still works without it
    return undefined;
  }
}

async function uploadFile(
  client: MatrixClient,
  file: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<string> {
  return await client.uploadContent(file, params.contentType, params.filename);
}

/**
 * Upload media with optional encryption for E2EE rooms.
 */
export async function uploadMediaMaybeEncrypted(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Check if room is encrypted and crypto is available
  const isEncrypted = client.crypto && (await client.crypto.isRoomEncrypted(roomId));

  if (isEncrypted && client.crypto) {
    // Encrypt the media before uploading
    const encrypted = await client.crypto.encryptMedia(buffer);
    const mxc = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }

  // Upload unencrypted
  const mxc = await uploadFile(client, buffer, params);
  return { url: mxc };
}
