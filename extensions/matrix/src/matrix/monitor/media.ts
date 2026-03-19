import { fetchWithSsrFGuard } from "../../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixConfigForAccount } from "../client.js";
import { loadMatrixCredentials } from "../credentials.js";
import type { MatrixClient } from "../sdk.js";

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

const MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

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
  accountId?: string | null;
}): Promise<{ buffer: Buffer; headerType?: string } | null> {
  const parsed = parseMxcUrl(params.mxcUrl);
  if (!parsed) {
    throw new Error(`Invalid mxc:// URL: ${params.mxcUrl}`);
  }

  // Get the homeserver base URL via mxcToHttp
  const httpUrl = await Promise.resolve(params.client.mxcToHttp(params.mxcUrl));
  if (!httpUrl) {
    return null;
  }

  const urlObj = new URL(httpUrl);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

  // Try the authenticated media endpoint first (MSC3916).
  // Required when the homeserver has unauthenticated media disabled.
  const cfg = getMatrixRuntime().config.loadConfig() as CoreConfig;
  const resolvedCfg = resolveMatrixConfigForAccount(cfg, params.accountId ?? undefined, process.env);
  const storedCreds = loadMatrixCredentials(process.env, params.accountId ?? undefined);
  const accessToken = resolvedCfg.accessToken ?? storedCreds?.accessToken;

  if (accessToken) {
    try {
      const authMediaUrl = `${baseUrl}/_matrix/client/v1/media/download/${parsed.serverName}/${parsed.mediaId}`;
      const { response, release } = await fetchWithSsrFGuard({
        url: authMediaUrl,
        init: { headers: { Authorization: `Bearer ${accessToken}` } },
        auditContext: "matrix.media.download",
      });
      try {
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          if (buffer.byteLength > params.maxBytes) {
            throw new Error("Matrix media exceeds configured size limit");
          }
          const contentType = response.headers.get("content-type") ?? undefined;
          return { buffer, headerType: contentType };
        }
      } finally {
        await release();
      }
    } catch {
      // Fall through to SDK fallback
    }
  }

  // Fall back to the SDK's downloadContent (handles unauthenticated endpoint)
  try {
    const buffer = await params.client.downloadContent(params.mxcUrl, {
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
    });
    return { buffer };
  } catch (err) {
    throw new Error(`Matrix media download failed: ${String(err)}`, { cause: err });
  }
}

/**
 * Download and decrypt encrypted media from a Matrix room.
 * Uses the Matrix crypto adapter's decryptMedia helper.
 */
async function fetchEncryptedMediaBuffer(params: {
  client: MatrixClient;
  file: EncryptedFile;
  maxBytes: number;
}): Promise<{ buffer: Buffer } | null> {
  if (!params.client.crypto) {
    throw new Error("Cannot decrypt media: crypto not enabled");
  }

  const decrypted = await params.client.crypto.decryptMedia(
    params.file as Parameters<typeof params.client.crypto.decryptMedia>[0],
    {
      maxBytes: params.maxBytes,
      readIdleTimeoutMs: MATRIX_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS,
    },
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
  accountId?: string | null;
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
      accountId: params.accountId,
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
