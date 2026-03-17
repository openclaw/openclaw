import { getMatrixRuntime } from "../../runtime.js";
import { applyMatrixFormatting } from "./formatting.js";
const getCore = () => getMatrixRuntime();
function buildMatrixMediaInfo(params) {
  const base = {};
  if (Number.isFinite(params.size)) {
    base.size = params.size;
  }
  if (params.mimetype) {
    base.mimetype = params.mimetype;
  }
  if (params.imageInfo) {
    const dimensional = {
      ...base,
      ...params.imageInfo
    };
    if (typeof params.durationMs === "number") {
      const videoInfo = {
        ...dimensional,
        duration: params.durationMs
      };
      return videoInfo;
    }
    return dimensional;
  }
  if (typeof params.durationMs === "number") {
    const timedInfo = {
      ...base,
      duration: params.durationMs
    };
    return timedInfo;
  }
  if (Object.keys(base).length === 0) {
    return void 0;
  }
  return base;
}
function buildMediaContent(params) {
  const info = buildMatrixMediaInfo({
    size: params.size,
    mimetype: params.mimetype,
    durationMs: params.durationMs,
    imageInfo: params.imageInfo
  });
  const base = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info: info ?? void 0
  };
  if (!params.file && params.url) {
    base.url = params.url;
  }
  if (params.file) {
    base.file = params.file;
  }
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    if (typeof params.durationMs === "number") {
      base["org.matrix.msc1767.audio"] = {
        duration: params.durationMs
      };
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
async function prepareImageInfo(params) {
  const meta = await getCore().media.getImageMetadata(params.buffer).catch(() => null);
  if (!meta) {
    return void 0;
  }
  const imageInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getCore().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true
      });
      const thumbMeta = await getCore().media.getImageMetadata(thumbBuffer).catch(() => null);
      const thumbUri = await params.client.uploadContent(
        thumbBuffer,
        "image/jpeg",
        "thumbnail.jpg"
      );
      imageInfo.thumbnail_url = thumbUri;
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength
        };
      }
    } catch {
    }
  }
  return imageInfo;
}
async function resolveMediaDurationMs(params) {
  if (params.kind !== "audio" && params.kind !== "video") {
    return void 0;
  }
  try {
    const { parseBuffer } = await import("music-metadata");
    const fileInfo = params.contentType || params.fileName ? {
      mimeType: params.contentType,
      size: params.buffer.byteLength,
      path: params.fileName
    } : void 0;
    const metadata = await parseBuffer(params.buffer, fileInfo, {
      duration: true,
      skipCovers: true
    });
    const durationSeconds = metadata.format.duration;
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
      return Math.max(0, Math.round(durationSeconds * 1e3));
    }
  } catch {
  }
  return void 0;
}
async function uploadFile(client, file, params) {
  return await client.uploadContent(file, params.contentType, params.filename);
}
async function uploadMediaMaybeEncrypted(client, roomId, buffer, params) {
  const isEncrypted = client.crypto && await client.crypto.isRoomEncrypted(roomId);
  if (isEncrypted && client.crypto) {
    const encrypted = await client.crypto.encryptMedia(buffer);
    const mxc2 = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
    const file = { url: mxc2, ...encrypted.file };
    return {
      url: mxc2,
      file
    };
  }
  const mxc = await uploadFile(client, buffer, params);
  return { url: mxc };
}
export {
  buildMatrixMediaInfo,
  buildMediaContent,
  prepareImageInfo,
  resolveMediaDurationMs,
  uploadMediaMaybeEncrypted
};
