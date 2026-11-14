import { getMatrixRuntime } from "../../runtime.js";
import type { DimensionalFileInfo, EncryptedFile, MatrixClient } from "../sdk.js";

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
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
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
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
