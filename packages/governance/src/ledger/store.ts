/**
 * Content store abstraction for ledger data.
 *
 * Stores borsh-serialized bytes keyed by SHA-256 hash.
 * Implementations: InMemoryContentStore (tests), S3ContentStore (MinIO/S3).
 *
 * All content is content-addressed: the key IS the hash of the value.
 * This makes verification trivial — hash the bytes, compare to the key.
 */

import { toHex } from "../identity/did.js";

/**
 * Dynamic import of @aws-sdk/client-s3, hidden from TypeScript's module resolution.
 * The module name is constructed at runtime so tsc doesn't try to resolve it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importS3SDK(): Promise<any> {
  const moduleName = ["@aws-sdk", "client-s3"].join("/");
  try {
    return await import(/* webpackIgnore: true */ moduleName);
  } catch {
    return null;
  }
}

// ── Interface ────────────────────────────────────────────────────────────────

/** Content store configuration. */
export interface ContentStoreConfig {
  /** S3-compatible endpoint (e.g., "http://192.168.2.50:9000"). */
  endpoint?: string;
  /** S3 bucket name. */
  bucket?: string;
  /** S3 access key ID. */
  accessKeyId?: string;
  /** S3 secret access key. */
  secretAccessKey?: string;
  /** S3 region (default: "us-east-1" for MinIO compatibility). */
  region?: string;
  /** Key prefix for all objects (e.g., "governance/tenant-123/"). */
  prefix?: string;
}

/** A content-addressed blob store for ledger data. */
export interface ContentStore {
  /**
   * Store content bytes under their hash key.
   *
   * @param hash - 32-byte SHA-256 hash (the content address).
   * @param data - The borsh-serialized bytes to store.
   * @param prefix - Optional path prefix (e.g., "events/", "batches/").
   */
  put(hash: Uint8Array, data: Uint8Array, prefix?: string): Promise<void>;

  /**
   * Retrieve content by its hash.
   *
   * @returns The stored bytes, or null if not found.
   */
  get(hash: Uint8Array, prefix?: string): Promise<Uint8Array | null>;

  /** Check if content exists for a given hash. */
  has(hash: Uint8Array, prefix?: string): Promise<boolean>;

  /** Delete content by hash. */
  delete(hash: Uint8Array, prefix?: string): Promise<void>;

  /** List all hashes under a prefix. Returns hex-encoded hashes. */
  list(prefix?: string): Promise<string[]>;
}

// ── In-Memory Implementation ─────────────────────────────────────────────────

/**
 * In-memory content store for testing and development.
 * Not persistent — data is lost when the process exits.
 */
export class InMemoryContentStore implements ContentStore {
  private store = new Map<string, Uint8Array>();

  async put(hash: Uint8Array, data: Uint8Array, prefix = ""): Promise<void> {
    const key = this.makeKey(hash, prefix);
    this.store.set(key, new Uint8Array(data));
  }

  async get(hash: Uint8Array, prefix = ""): Promise<Uint8Array | null> {
    const key = this.makeKey(hash, prefix);
    const data = this.store.get(key);
    return data ? new Uint8Array(data) : null;
  }

  async has(hash: Uint8Array, prefix = ""): Promise<boolean> {
    return this.store.has(this.makeKey(hash, prefix));
  }

  async delete(hash: Uint8Array, prefix = ""): Promise<void> {
    this.store.delete(this.makeKey(hash, prefix));
  }

  async list(prefix = ""): Promise<string[]> {
    const results: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        results.push(key.slice(prefix.length));
      }
    }
    return results;
  }

  /** Number of items in the store (for testing). */
  get size(): number {
    return this.store.size;
  }

  /** Clear all stored data (for testing). */
  clear(): void {
    this.store.clear();
  }

  private makeKey(hash: Uint8Array, prefix: string): string {
    const hex = toHex(hash);
    return prefix ? `${prefix}${hex}` : hex;
  }
}

// ── S3-Compatible Implementation ─────────────────────────────────────────────

/**
 * S3-compatible content store for MinIO / AWS S3 / any S3-compatible service.
 *
 * Object key structure:
 *   {prefix}{objectPrefix}{shardDir}/{hash}.borsh
 *
 * Example for MinIO on nasidius:
 *   governance/events/a1/a1b2c3d4e5f6...borsh
 *
 * The shard directory (first 2 hex chars) prevents directory listing
 * performance degradation with millions of objects.
 *
 * Requires @aws-sdk/client-s3 as a peer dependency.
 * Only imported when S3ContentStore is instantiated.
 */
/**
 * S3-compatible content store for MinIO / AWS S3 / any S3-compatible service.
 *
 * Object key structure:
 *   {prefix}{objectPrefix}{shardDir}/{hash}.borsh
 *
 * Example for MinIO on nasidius:
 *   governance/events/a1/a1b2c3d4e5f6...borsh
 *
 * The shard directory (first 2 hex chars) prevents directory listing
 * performance degradation with millions of objects.
 *
 * Requires @aws-sdk/client-s3 as a peer dependency.
 * Only imported when S3ContentStore is instantiated.
 */
export class S3ContentStore implements ContentStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private bucket: string;
  private prefix: string;
  private config: ContentStoreConfig;

  constructor(config: ContentStoreConfig) {
    if (!config.endpoint || !config.bucket) {
      throw new Error("S3ContentStore requires endpoint and bucket");
    }
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";
    this.config = config;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.client) {
      return this.client;
    }

    // Dynamic import — @aws-sdk/client-s3 is a peer dependency
    const sdk = await importS3SDK();
    if (!sdk) {
      throw new Error(
        "S3ContentStore requires @aws-sdk/client-s3. Install it: pnpm add @aws-sdk/client-s3",
      );
    }
    const S3 = sdk.S3Client as new (config: Record<string, unknown>) => unknown;
    this.client = new S3({
      endpoint: this.config.endpoint,
      region: this.config.region ?? "us-east-1",
      credentials: {
        accessKeyId: this.config.accessKeyId ?? "",
        secretAccessKey: this.config.secretAccessKey ?? "",
      },
      forcePathStyle: true, // Required for MinIO
    });
    return this.client;
  }

  async put(hash: Uint8Array, data: Uint8Array, prefix = ""): Promise<void> {
    const client = await this.getClient();
    const sdk = await importS3SDK().catch(() => null);
    if (!sdk) {
      throw new Error("@aws-sdk/client-s3 not available");
    }
    const key = this.makeKey(hash, prefix);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: "application/octet-stream",
      }),
    );
  }

  async get(hash: Uint8Array, prefix = ""): Promise<Uint8Array | null> {
    const client = await this.getClient();
    const sdk = await importS3SDK().catch(() => null);
    if (!sdk) {
      throw new Error("@aws-sdk/client-s3 not available");
    }
    const key = this.makeKey(hash, prefix);

    try {
      const response = (await client.send(
        new sdk.GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      )) as Record<string, unknown>;

      if (!response.Body) {
        return null;
      }

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }

      let totalLength = 0;
      for (const c of chunks) {
        totalLength += c.length;
      }
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      return result;
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound")) {
        return null;
      }
      throw err;
    }
  }

  async has(hash: Uint8Array, prefix = ""): Promise<boolean> {
    const client = await this.getClient();
    const sdk = await importS3SDK().catch(() => null);
    if (!sdk) {
      throw new Error("@aws-sdk/client-s3 not available");
    }
    const key = this.makeKey(hash, prefix);

    try {
      await client.send(
        new sdk.HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(hash: Uint8Array, prefix = ""): Promise<void> {
    const client = await this.getClient();
    const sdk = await importS3SDK().catch(() => null);
    if (!sdk) {
      throw new Error("@aws-sdk/client-s3 not available");
    }
    const key = this.makeKey(hash, prefix);

    await client.send(
      new sdk.DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async list(prefix = ""): Promise<string[]> {
    const client = await this.getClient();
    const sdk = await importS3SDK().catch(() => null);
    if (!sdk) {
      throw new Error("@aws-sdk/client-s3 not available");
    }
    const fullPrefix = `${this.prefix}${prefix}`;
    const results: string[] = [];

    let continuationToken: string | undefined;
    do {
      const response = (await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      )) as Record<string, unknown>;

      const contents = response.Contents as Array<Record<string, string>> | undefined;
      if (contents) {
        for (const obj of contents) {
          if (obj.Key) {
            const relative = obj.Key.slice(fullPrefix.length);
            const hashPart = relative.replace(/^[a-f0-9]{2}\//, "").replace(/\.borsh$/, "");
            if (hashPart) {
              results.push(hashPart);
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken as string | undefined;
    } while (continuationToken);

    return results;
  }

  private makeKey(hash: Uint8Array, prefix: string): string {
    const hex = toHex(hash);
    const shard = hex.slice(0, 2);
    return `${this.prefix}${prefix}${shard}/${hex}.borsh`;
  }
}
