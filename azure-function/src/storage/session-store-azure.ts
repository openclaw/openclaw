/**
 * Azure Blob Storage session state provider for serverless OpenClaw deployments.
 *
 * Replaces the local-filesystem session store with Azure Blob Storage so that
 * ephemeral Function App disks do not lose WhatsApp / Telegram session data
 * between invocations.
 *
 * Environment variable:
 *   AZURE_STORAGE_CONNECTION_STRING – connection string for the storage account.
 */

import {
  BlobServiceClient,
  type ContainerClient,
  type BlockBlobClient,
} from "@azure/storage-blob";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONTAINER_NAME = "sessions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connectionString(): string {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    throw new Error(
      "AZURE_STORAGE_CONNECTION_STRING environment variable is required for AzureBlobSessionStore",
    );
  }
  return cs;
}

function blobName(agentId: string, sessionKey: string): string {
  // Use a hierarchical path inside the container: <agentId>/<sessionKey>.json
  return `${agentId}/${sessionKey}.json`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AzureBlobSessionStore {
  private containerClient: ContainerClient;

  constructor() {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString());
    this.containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  }

  /** Ensure the blob container exists (idempotent). */
  async ensureContainer(): Promise<void> {
    await this.containerClient.createIfNotExists();
  }

  /**
   * Load a session entry by agent and session key.
   * Returns `undefined` when the session does not yet exist.
   */
  async load<T = unknown>(agentId: string, sessionKey: string): Promise<T | undefined> {
    const blob = this.containerClient.getBlockBlobClient(blobName(agentId, sessionKey));
    try {
      const response = await blob.download(0);
      const body = await streamToString(response.readableStreamBody);
      return JSON.parse(body) as T;
    } catch (err: unknown) {
      if (isBlobNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Persist a session entry. */
  async save<T = unknown>(agentId: string, sessionKey: string, data: T): Promise<void> {
    const blob = this.containerClient.getBlockBlobClient(blobName(agentId, sessionKey));
    const content = JSON.stringify(data, null, 2);
    await blob.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
  }

  /** Delete a session entry. */
  async delete(agentId: string, sessionKey: string): Promise<void> {
    const blob = this.containerClient.getBlockBlobClient(blobName(agentId, sessionKey));
    await blob.deleteIfExists();
  }

  /**
   * List all session keys for a given agent.
   */
  async listSessionKeys(agentId: string): Promise<string[]> {
    const prefix = `${agentId}/`;
    const keys: string[] = [];
    for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
      // Strip prefix and .json suffix
      const raw = blob.name.slice(prefix.length);
      if (raw.endsWith(".json")) {
        keys.push(raw.slice(0, -5));
      }
    }
    return keys;
  }

  /** Check whether a session exists. */
  async exists(agentId: string, sessionKey: string): Promise<boolean> {
    const blob = this.containerClient.getBlockBlobClient(blobName(agentId, sessionKey));
    return blob.exists();
  }
}

// ---------------------------------------------------------------------------
// Stream helper
// ---------------------------------------------------------------------------

async function streamToString(
  stream: NodeJS.ReadableStream | undefined,
): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function isBlobNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    return (err as { statusCode: number }).statusCode === 404;
  }
  return false;
}
