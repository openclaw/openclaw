import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { WigForgeResolvedR2Config } from "./config.js";

export class WigForgeR2Sync {
  private readonly client: S3Client;

  constructor(readonly config: WigForgeResolvedR2Config) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async uploadObject(params: {
    assetId: string;
    fileName: string;
    body: Buffer | string;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ key: string; url?: string }> {
    const key = this.objectKey(params.assetId, params.fileName);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: params.body,
        ContentType: params.contentType,
        CacheControl: params.cacheControl || "public, max-age=31536000, immutable",
        Metadata: {
          source: "wig-forge",
          assetId: params.assetId,
          uploadedAt: new Date().toISOString(),
        },
      }),
    );

    return {
      key,
      url: this.publicUrlFor(key),
    };
  }

  private objectKey(assetId: string, fileName: string): string {
    const prefix = this.config.keyPrefix?.replace(/^\/+|\/+$/g, "") || "wig-forge";
    return `${prefix}/assets/${sanitizePathSegment(assetId)}/${sanitizePathSegment(fileName)}`;
  }

  private publicUrlFor(key: string): string | undefined {
    if (!this.config.publicBaseUrl) {
      return undefined;
    }
    return `${this.config.publicBaseUrl}/${key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }
}

function sanitizePathSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}
