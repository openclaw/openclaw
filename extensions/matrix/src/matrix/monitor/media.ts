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
  // Parse mxc:// URL to extract server and mediaId
  // Format: mxc://server.name/mediaId
  const match = params.mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid mxc:// URL: ${params.mxcUrl}`);
  }
  const [, serverName, mediaId] = match;

  // Construct authenticated media endpoint URL
  // New spec (Matrix 1.11+): /_matrix/client/v1/media/download/{serverName}/{mediaId}
  // See: https://spec.matrix.org/v1.11/client-server-api/#get_matrixclientv1mediadownloadservernamemediaid
  const homeserverUrl = params.client.homeserverUrl;
  const url = `${homeserverUrl}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;

  // Use authenticated fetch with access token
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${params.client.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > params.maxBytes) {
      throw new Error("Matrix media exceeds configured size limit");
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      buffer: Buffer.from(arrayBuffer),
      headerType: contentType,
    };
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
