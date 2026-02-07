/**
 * S3 client wrapper for project virtual disk operations.
 *
 * Provides isolated storage per project at: s3://{bucket}/{orgId}/{projectId}/
 * All operations validate paths to prevent directory traversal attacks.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface FileMetadata {
  path: string;
  size: number;
  lastModified: Date;
  isDirectory: boolean;
}

/** Singleton S3 client instance */
let s3Client: S3Client | null = null;
let currentConfig: S3Config | null = null;

/**
 * Get or create S3 client instance.
 */
export function getS3Client(config: S3Config): S3Client {
  // Return existing client if config hasn't changed
  if (
    s3Client &&
    currentConfig &&
    currentConfig.bucket === config.bucket &&
    currentConfig.region === config.region &&
    currentConfig.accessKeyId === config.accessKeyId
  ) {
    return s3Client;
  }

  const clientConfig: {
    region: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
  } = {
    region: config.region,
  };

  // Use explicit credentials if provided, otherwise rely on default credential chain
  if (config.accessKeyId && config.secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }

  s3Client = new S3Client(clientConfig);
  currentConfig = config;
  return s3Client;
}

/**
 * Validate and normalize a relative path.
 * Prevents directory traversal attacks.
 */
export function validatePath(relativePath: string): string {
  const trimmed = relativePath.trim();

  // Reject empty paths
  if (!trimmed) {
    throw new Error("Path cannot be empty");
  }

  // Reject absolute paths
  if (trimmed.startsWith("/")) {
    throw new Error("Absolute paths are not allowed. Use relative paths only.");
  }

  // Reject path traversal attempts
  if (trimmed.includes("..")) {
    throw new Error("Path traversal (..) is not allowed");
  }

  // Reject paths with null bytes
  if (trimmed.includes("\0")) {
    throw new Error("Invalid path: contains null bytes");
  }

  // Normalize path separators and remove leading/trailing slashes
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");

  return normalized;
}

/**
 * Build the full S3 key for a project file.
 * Format: {orgId}/{projectId}/{relativePath}
 */
export function buildS3Key(orgId: string, projectId: string, relativePath: string): string {
  const validatedPath = validatePath(relativePath);
  return `${orgId}/${projectId}/${validatedPath}`;
}

/**
 * Build the S3 prefix for listing a project directory.
 */
export function buildS3Prefix(orgId: string, projectId: string, relativePath?: string): string {
  const base = `${orgId}/${projectId}/`;
  if (!relativePath || relativePath === "/" || relativePath === ".") {
    return base;
  }
  const validatedPath = validatePath(relativePath);
  // Ensure prefix ends with / for directory listing
  return `${base}${validatedPath}${validatedPath.endsWith("/") ? "" : "/"}`;
}

/**
 * Read a file from S3.
 */
export async function s3ReadFile(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
): Promise<{ content: string; metadata: FileMetadata }> {
  const client = getS3Client(config);
  const key = buildS3Key(orgId, projectId, relativePath);

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );

    const content = await response.Body?.transformToString("utf-8");
    if (content === undefined) {
      throw new Error("Failed to read file content");
    }

    return {
      content,
      metadata: {
        path: relativePath,
        size: response.ContentLength ?? 0,
        lastModified: response.LastModified ?? new Date(),
        isDirectory: false,
      },
    };
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      throw new Error(`File not found: ${relativePath}`);
    }
    throw error;
  }
}

/**
 * Write a file to S3.
 */
export async function s3WriteFile(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const client = getS3Client(config);
  const key = buildS3Key(orgId, projectId, relativePath);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: content,
      ContentType: getContentType(relativePath),
    }),
  );
}

/**
 * Delete a file from S3.
 */
export async function s3DeleteFile(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
): Promise<void> {
  const client = getS3Client(config);
  const key = buildS3Key(orgId, projectId, relativePath);

  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );
}

/**
 * Check if a file or directory exists in S3.
 */
export async function s3Exists(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  const client = getS3Client(config);
  const key = buildS3Key(orgId, projectId, relativePath);

  // First check if it's a file
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
    return { exists: true, isDirectory: false };
  } catch {
    // Not a file, check if it's a directory (has objects with this prefix)
  }

  // Check if it's a directory by listing objects with this prefix
  const prefix = buildS3Prefix(orgId, projectId, relativePath);
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      MaxKeys: 1,
    }),
  );

  if (response.Contents && response.Contents.length > 0) {
    return { exists: true, isDirectory: true };
  }

  return { exists: false, isDirectory: false };
}

/**
 * Get file metadata from S3.
 */
export async function s3Stat(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
): Promise<FileMetadata> {
  const client = getS3Client(config);
  const key = buildS3Key(orgId, projectId, relativePath);

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );

    return {
      path: relativePath,
      size: response.ContentLength ?? 0,
      lastModified: response.LastModified ?? new Date(),
      isDirectory: false,
    };
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      // Check if it's a directory
      const prefix = buildS3Prefix(orgId, projectId, relativePath);
      const listResponse = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          MaxKeys: 1,
        }),
      );

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        return {
          path: relativePath,
          size: 0,
          lastModified: new Date(),
          isDirectory: true,
        };
      }

      throw new Error(`Path not found: ${relativePath}`);
    }
    throw error;
  }
}

/**
 * List files and directories in S3.
 */
export async function s3List(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath?: string,
  recursive?: boolean,
): Promise<{ files: FileMetadata[]; directories: string[] }> {
  const client = getS3Client(config);
  const prefix = buildS3Prefix(orgId, projectId, relativePath);
  const basePrefix = `${orgId}/${projectId}/`;

  const files: FileMetadata[] = [];
  const directories = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        Delimiter: recursive ? undefined : "/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    // Process files
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (!obj.Key) continue;

        // Get relative path from project root
        const relPath = obj.Key.slice(basePrefix.length);
        if (!relPath) continue;

        // Skip directory markers
        if (relPath.endsWith("/")) {
          directories.add(relPath.slice(0, -1));
          continue;
        }

        files.push({
          path: relPath,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(),
          isDirectory: false,
        });
      }
    }

    // Process common prefixes (directories) when not recursive
    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        if (!cp.Prefix) continue;
        const relPath = cp.Prefix.slice(basePrefix.length);
        if (relPath) {
          directories.add(relPath.endsWith("/") ? relPath.slice(0, -1) : relPath);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return {
    files,
    directories: Array.from(directories).sort(),
  };
}

/**
 * Create a directory marker in S3.
 * S3 doesn't have real directories, but we create a zero-byte object with trailing slash.
 */
export async function s3Mkdir(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
): Promise<void> {
  const client = getS3Client(config);
  const validatedPath = validatePath(relativePath);
  const key = `${orgId}/${projectId}/${validatedPath}/`;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: "",
      ContentType: "application/x-directory",
    }),
  );
}

/**
 * Delete a directory from S3.
 * If recursive is true, deletes all contents. Otherwise, fails if directory is not empty.
 */
export async function s3Rmdir(
  config: S3Config,
  orgId: string,
  projectId: string,
  relativePath: string,
  recursive?: boolean,
): Promise<{ deletedCount: number }> {
  const client = getS3Client(config);
  const prefix = buildS3Prefix(orgId, projectId, relativePath);

  // List all objects in the directory
  const { files, directories } = await s3List(config, orgId, projectId, relativePath, true);

  const totalItems = files.length + directories.length;

  if (totalItems > 0 && !recursive) {
    throw new Error(
      `Directory is not empty: ${relativePath}. Use recursive=true to delete all contents.`,
    );
  }

  if (totalItems === 0) {
    // Just delete the directory marker if it exists
    const dirKey = `${orgId}/${projectId}/${validatePath(relativePath)}/`;
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: dirKey,
      }),
    );
    return { deletedCount: 1 };
  }

  // Delete all objects in batches of 1000 (S3 limit)
  const basePrefix = `${orgId}/${projectId}/`;
  const allKeys = [
    ...files.map((f) => `${basePrefix}${f.path}`),
    ...directories.map((d) => `${basePrefix}${d}/`),
    prefix, // Include the directory marker itself
  ];

  let deletedCount = 0;
  for (let i = 0; i < allKeys.length; i += 1000) {
    const batch = allKeys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
    deletedCount += batch.length;
  }

  return { deletedCount };
}

/**
 * Get content type based on file extension.
 */
function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    js: "application/javascript",
    ts: "application/typescript",
    html: "text/html",
    css: "text/css",
    xml: "application/xml",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    csv: "text/csv",
    py: "text/x-python",
    rb: "text/x-ruby",
    sh: "text/x-shellscript",
    sql: "application/sql",
  };
  return contentTypes[ext ?? ""] ?? "application/octet-stream";
}
