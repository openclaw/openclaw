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

async function fetchMatrixMediaBuffer(params: {
  client: MatrixClient;
  mxcUrl: string;
  maxBytes: number;
}): Promise<{ buffer: Buffer; headerType?: string } | null> {
  // @vector-im/matrix-bot-sdk provides mxcToHttp helper
  const url = params.client.mxcToHttp(params.mxcUrl);
  if (!url) {
    return null;
  }

  // Use the client's download method which handles auth
  try {
    const buffer = await params.client.downloadContent(params.mxcUrl);
    if (buffer.byteLength > params.maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }
    return { buffer: Buffer.from(buffer) };
  } catch (err) {
    // Fallback: use authenticated media endpoint (Matrix v1.11+)
    // Servers with authenticated media enabled reject the legacy
    // /_matrix/media/v3/download endpoint with 403.
    const mxcMatch = params.mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!mxcMatch) {
      throw new Error(`Invalid mxc URL: ${params.mxcUrl}`);
    }
    const [, serverName, mediaId] = mxcMatch;

    const homeserverUrl = params.client.homeserverUrl.replace(/\/$/, "");
    const authUrl = `${homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;

    const response = await fetch(authUrl, {
      headers: {
        Authorization: `Bearer ${params.client.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Authenticated media download failed: ${response.status} ${response.statusText} (original: ${String(err)})`,
        { cause: err },
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength > params.maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }

    return { buffer };
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
  const decrypted = await params.client.crypto.decryptMedia(params.file);

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
