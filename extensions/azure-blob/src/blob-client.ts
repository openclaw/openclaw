import type { Readable } from "node:stream";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveAzureBlobAccountKey,
  resolveAzureBlobAccountName,
  resolveAzureBlobAccountUrl,
  resolveAzureBlobConnectionString,
} from "./config.js";

export type AzureBlobClientError = {
  ok: false;
  message: string;
};

export type AzureBlobReadOk = {
  ok: true;
  data: Buffer;
  contentType?: string;
  contentLength?: number;
  truncated: boolean;
};

export const DEFAULT_LIST_MAX_RESULTS = 200;
export const HARD_MAX_LIST_RESULTS = 1000;

export type AzureBlobListContainersOk = {
  ok: true;
  containers: Array<{ name: string }>;
  truncated: boolean;
};

export type AzureBlobListBlobsOk = {
  ok: true;
  containerName: string;
  blobs: Array<{
    name: string;
    contentLength?: number;
    contentType?: string;
  }>;
  truncated: boolean;
};

function clampListMaxResults(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LIST_MAX_RESULTS;
  }
  const floor = Math.floor(requested);
  return Math.min(Math.max(floor, 1), HARD_MAX_LIST_RESULTS);
}

function formatListError(prefix: string, err: unknown): AzureBlobClientError {
  const status =
    err && typeof err === "object" && "statusCode" in err
      ? String((err as { statusCode?: number }).statusCode ?? "")
      : "";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: string }).code ?? "")
      : "";
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    message: `${prefix} (${code || status || "error"}): ${message}`,
  };
}

export async function listBlobContainers(params: {
  cfg?: OpenClawConfig;
  prefix?: string;
  maxResults?: number;
}): Promise<AzureBlobListContainersOk | AzureBlobClientError> {
  const client = createBlobServiceClient(params.cfg);
  if (isAzureBlobClientError(client)) {
    return client;
  }

  const max = clampListMaxResults(params.maxResults);
  const prefix = typeof params.prefix === "string" ? params.prefix.trim() : "";

  try {
    const containers: Array<{ name: string }> = [];
    let truncated = false;
    const iter = client.listContainers({
      ...(prefix ? { prefix } : {}),
    });
    for await (const item of iter) {
      if (typeof item.name !== "string" || !item.name) {
        continue;
      }
      if (containers.length >= max) {
        truncated = true;
        break;
      }
      containers.push({ name: item.name });
    }
    return { ok: true, containers, truncated };
  } catch (err: unknown) {
    return formatListError("Azure list containers failed", err);
  }
}

export async function listBlobsInContainer(params: {
  cfg?: OpenClawConfig;
  containerName: string;
  prefix?: string;
  maxResults?: number;
}): Promise<AzureBlobListBlobsOk | AzureBlobClientError> {
  const client = createBlobServiceClient(params.cfg);
  if (isAzureBlobClientError(client)) {
    return client;
  }

  const max = clampListMaxResults(params.maxResults);
  const namePrefix = typeof params.prefix === "string" ? params.prefix.trim() : "";
  const container = client.getContainerClient(params.containerName.trim());

  try {
    const blobs: AzureBlobListBlobsOk["blobs"] = [];
    let truncated = false;
    const iter = container.listBlobsFlat({
      ...(namePrefix ? { prefix: namePrefix } : {}),
    });
    for await (const item of iter) {
      if (typeof item.name !== "string" || !item.name) {
        continue;
      }
      if (blobs.length >= max) {
        truncated = true;
        break;
      }
      const props = item.properties;
      const len = props?.contentLength;
      const ct = props?.contentType;
      blobs.push({
        name: item.name,
        ...(typeof len === "number" && Number.isFinite(len) ? { contentLength: len } : {}),
        ...(typeof ct === "string" && ct.trim() ? { contentType: ct.trim() } : {}),
      });
    }
    return {
      ok: true,
      containerName: params.containerName.trim(),
      blobs,
      truncated,
    };
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? String((err as { statusCode?: number }).statusCode ?? "")
        : "";
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    if (status === "404" || code === "ContainerNotFound") {
      return {
        ok: false,
        message: `Container not found: ${params.containerName.trim()}`,
      };
    }
    return formatListError("Azure list blobs failed", err);
  }
}

async function readStreamToBufferMax(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const space = maxBytes - total;
    if (buf.length <= space) {
      chunks.push(buf);
      total += buf.length;
    } else {
      chunks.push(buf.subarray(0, space));
      total = maxBytes;
      stream.destroy();
      break;
    }
    if (total >= maxBytes) {
      break;
    }
  }
  return Buffer.concat(chunks, total);
}

function buildSharedKeyClient(cfg?: OpenClawConfig): BlobServiceClient | AzureBlobClientError {
  const accountName = resolveAzureBlobAccountName(cfg);
  const accountKey = resolveAzureBlobAccountKey(cfg);
  if (!accountName || !accountKey) {
    return {
      ok: false,
      message:
        "Azure Blob Storage is not configured: set connection string (AZURE_STORAGE_CONNECTION_STRING or plugins.entries.azure-blob.config.connectionString) or account name + key (AZURE_STORAGE_ACCOUNT_NAME / AZURE_STORAGE_ACCOUNT_KEY).",
    };
  }
  const urlOverride = resolveAzureBlobAccountUrl(cfg);
  const url = urlOverride ?? `https://${accountName}.blob.core.windows.net`;
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  return new BlobServiceClient(url, credential);
}

/** Resolves a {@link BlobServiceClient} from connection string or account key auth. */
export function createBlobServiceClient(
  cfg?: OpenClawConfig,
): BlobServiceClient | AzureBlobClientError {
  const connectionString = resolveAzureBlobConnectionString(cfg);
  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  }
  return buildSharedKeyClient(cfg);
}

function isAzureBlobClientError(
  client: BlobServiceClient | AzureBlobClientError,
): client is AzureBlobClientError {
  return "ok" in client && client.ok === false;
}

export async function readBlobBytes(params: {
  cfg?: OpenClawConfig;
  containerName: string;
  blobName: string;
  maxBytes: number;
}): Promise<AzureBlobReadOk | AzureBlobClientError> {
  const client = createBlobServiceClient(params.cfg);
  if (isAzureBlobClientError(client)) {
    return client;
  }

  const container = client.getContainerClient(params.containerName);
  const blob = container.getBlobClient(params.blobName);

  let contentLength: number | undefined;
  let contentType: string | undefined;
  try {
    const props = await blob.getProperties();
    contentLength = typeof props.contentLength === "number" ? props.contentLength : undefined;
    contentType =
      typeof props.contentType === "string" && props.contentType.trim()
        ? props.contentType
        : undefined;
  } catch {
    // Properties are optional for truncation detection; download will still run.
  }

  try {
    const maxBytes = params.maxBytes;
    let data: Buffer;

    if (typeof contentLength === "number" && Number.isFinite(contentLength) && contentLength >= 0) {
      const n = Math.min(maxBytes, Math.floor(contentLength));
      data = n === 0 ? Buffer.alloc(0) : await blob.downloadToBuffer(0, n);
    } else {
      const response = await blob.download(0, maxBytes);
      const body = response.readableStreamBody;
      if (!body) {
        return {
          ok: false,
          message: "Azure Blob download returned no response body.",
        };
      }
      data = await readStreamToBufferMax(body as Readable, maxBytes);
    }

    const truncated =
      typeof contentLength === "number" && Number.isFinite(contentLength)
        ? contentLength > data.length
        : data.length >= maxBytes;

    return {
      ok: true,
      data,
      contentType,
      contentLength,
      truncated,
    };
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "statusCode" in err
        ? String((err as { statusCode?: number }).statusCode ?? "")
        : "";
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    const message = err instanceof Error ? err.message : String(err);
    if (status === "404" || code === "BlobNotFound") {
      return {
        ok: false,
        message: `Blob not found: ${params.containerName}/${params.blobName}`,
      };
    }
    return {
      ok: false,
      message: `Azure Blob read failed (${code || status || "error"}): ${message}`,
    };
  }
}
