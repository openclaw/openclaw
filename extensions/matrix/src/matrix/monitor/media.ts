import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { getMatrixRuntime } from "../../runtime.js";

// Type for encrypted file info
type EncryptedFile = {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
};

/**
 * Parse an mxc:// URL into server name and media ID.
 * mxc://server.name:port/mediaId -> { serverName: "server.name:port", mediaId: "mediaId" }
 */
function parseMxcUrl(mxcUrl: string): { serverName: string; mediaId: string } | null {
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { serverName: match[1], mediaId: match[2] };
}

async function fetchMatrixMediaBuffer(params: {
  client: MatrixClient;
  mxcUrl: string;
  maxBytes: number;
}): Promise<{ buffer: Buffer; headerType?: string } | null> {
  const parsed = parseMxcUrl(params.mxcUrl);
  if (!parsed) {
    throw new Error(`Invalid mxc:// URL: ${params.mxcUrl}`);
  }

  // Get the homeserver base URL via mxcToHttp (may be async in some SDK versions)
  const httpUrl = await Promise.resolve(params.client.mxcToHttp(params.mxcUrl));
  if (!httpUrl) {
    return null;
  }

  const urlObj = new URL(httpUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

  // Try the authenticated media endpoint first (MSC3916).
  // Required when the homeserver has unauthenticated media disabled.
  const cfg = getMatrixRuntime().config.loadConfig();
  const accessToken = (cfg as { channels?: { matrix?: { accessToken?: string } } }).channels?.matrix
    ?.accessToken;

  if (accessToken) {
    try {
      const authMediaUrl = `${baseUrl}/_matrix/client/v1/media/download/${parsed.serverName}/${parsed.mediaId}`;
      const response = await fetch(authMediaUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.byteLength > params.maxBytes) {
          throw new Error("Matrix media exceeds configured size limit");
        }
        const contentType = response.headers.get("content-type") ?? undefined;
        return { buffer, headerType: contentType };
      }
    } catch {
      // Fall through to SDK fallback
    }
  }

  // Fall back to the SDK's downloadContent (handles unauthenticated endpoint)
  try {
    const result = await params.client.downloadContent(params.mxcUrl);
    const raw = result.data ?? result;
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buffer.byteLength > params.maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }
    return { buffer, headerType: result.contentType };
  } catch (err) {
    throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
  }
}

/**
 * Download and decrypt encrypted media from a Matrix room.
 * Uses @vector-im/matrix-bot-sdk's decryptMedia which handles both download and decryption.
 */
async function fetchEncryptedMediaBuffer(params: {
  client: MatrixClient;
  file: EncryptedFile;
  maxBytes: number;
}): Promise<{ buffer: Buffer } | null> {
  if (!params.client.crypto) {
    throw new Error("Cannot decrypt media: crypto not enabled");
  }

  // decryptMedia handles downloading and decrypting the encrypted content internally
  const decrypted = await params.client.crypto.decryptMedia(
    params.file as Parameters<typeof params.client.crypto.decryptMedia>[0],
  );

  if (decrypted.byteLength > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }

  return { buffer: decrypted };
}

export async function downloadMatrixMedia(params: {
  client: MatrixClient;
  mxcUrl: string;
  contentType?: string;
  sizeBytes?: number;
  maxBytes: number;
  file?: EncryptedFile;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  let fetched: { buffer: Buffer; headerType?: string } | null;
  if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {
    throw new Error("Matrix media exceeds configured size limit");
  }

  if (params.file) {
    // Encrypted media
    fetched = await fetchEncryptedMediaBuffer({
      client: params.client,
      file: params.file,
      maxBytes: params.maxBytes,
    });
  } else {
    // Unencrypted media
    fetched = await fetchMatrixMediaBuffer({
      client: params.client,
      mxcUrl: params.mxcUrl,
      maxBytes: params.maxBytes,
    });
  }

  if (!fetched) {
    return null;
  }
  const headerType = fetched.headerType ?? params.contentType ?? undefined;
  const saved = await getMatrixRuntime().channel.media.saveMediaBuffer(
    fetched.buffer,
    headerType,
    "inbound",
    params.maxBytes,
  );
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[matrix media]",
  };
}
