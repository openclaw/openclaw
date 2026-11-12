import { getMatrixRuntime } from "../../runtime.js";
import type { DimensionalFileInfo, EncryptedFile, MatrixClient } from "../sdk.js";

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
// MSC4230: Element badges PNG/WebP/GIF/APNG/AVIF as "GIF" unless the event says they are still.
const MSC4230_IS_ANIMATED = "org.matrix.msc4230.is_animated";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True only when the bytes prove a single-frame JPEG, PNG or WebP; unknown stays unclaimed. */
function isStillImageBuffer(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // An APNG declares acTL before its first IDAT.
    for (let offset = 8; offset + 12 <= buffer.length;) {
      const type = buffer.toString("latin1", offset + 4, offset + 8);
      if (type === "acTL") {
        return false;
      }
      if (type === "IDAT") {
        return true;
      }
      offset += 12 + buffer.readUInt32BE(offset);
    }
    return false;
  }
  if (
    buffer.length >= 21 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    const chunk = buffer.toString("latin1", 12, 16);
    // Simple lossy/lossless WebP is single-frame; VP8X carries the animation flag.
    return chunk === "VP8 " || chunk === "VP8L" || (chunk === "VP8X" && (buffer[20]! & 0x02) === 0);
  }
  return false;
}

export async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
  roomId: string;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getMatrixRuntime()
    .media.getImageMetadata(params.buffer)
    .catch(() => null);
  if (!meta) {
    return undefined;
  }
  const imageInfo: DimensionalFileInfo & { [MSC4230_IS_ANIMATED]?: boolean } = {
    w: meta.width,
    h: meta.height,
    ...(isStillImageBuffer(params.buffer) ? { [MSC4230_IS_ANIMATED]: false } : {}),
  };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getMatrixRuntime().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getMatrixRuntime()
        .media.getImageMetadata(thumbBuffer)
        .catch(() => null);
      const result = await uploadMediaWithEncryption(params.client, params.roomId, thumbBuffer, {
        contentType: "image/jpeg",
        filename: "thumbnail.jpg",
      });
      if (result.file) {
        imageInfo.thumbnail_file = result.file;
      } else {
        imageInfo.thumbnail_url = result.url;
      }
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

export async function uploadMediaWithEncryption(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Downloads and thumbnail generation can yield while encryption changes;
  // resolve room policy at the upload boundary instead of reusing stale facts.
  if ((await client.prepareRoomForMessageSend(roomId)) === "m.room.encrypted") {
    if (!client.crypto) {
      throw new Error("Encrypted Matrix room: enable encryption before uploading media");
    }
    const encrypted = await client.crypto.encryptMedia(buffer);
    // Upload URLs and headers are visible; keep real media metadata inside
    // the encrypted room event instead of exposing it with the ciphertext.
    const mxc = await client.uploadContent(encrypted.buffer, "application/octet-stream");
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }

  const mxc = await client.uploadContent(buffer, params.contentType, params.filename);
  return { url: mxc };
}
