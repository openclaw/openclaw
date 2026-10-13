import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3ServiceException,
  UploadPartCommand,
  type CompletedPart,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { StorageBackend } from "openclaw/plugin-sdk/plugin-entry";
import { describeR2Target, type R2Settings } from "./settings.js";

const PART_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;

class R2StorageError extends Error {}

function missingObject(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    error.name !== "NoSuchBucket" &&
    (error.$metadata.httpStatusCode === 404 ||
      error.name === "NoSuchKey" ||
      error.name === "NotFound")
  );
}

function storageError(error: unknown, settings: R2Settings, operation: string): Error {
  if (error instanceof R2StorageError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    const aborted = new Error("R2 operation aborted; retry when ready.");
    aborted.name = "AbortError";
    return aborted;
  }
  if (error instanceof S3ServiceException) {
    const code = error.$metadata.httpStatusCode;
    if (code === 401 || code === 403) {
      return new R2StorageError(
        `R2 access denied: the R2 token needs Object Read & Write on bucket ${settings.bucket}.`,
      );
    }
    if (error.name === "NoSuchBucket" || (operation === "probe" && code === 404)) {
      return new R2StorageError(
        `R2 bucket is missing; create bucket ${settings.bucket} in account ${settings.accountId}.`,
      );
    }
    if (code === 409 || code === 412) {
      return new R2StorageError(
        "R2 object already exists or a concurrent write conflicted; use a new object key.",
      );
    }
  }
  // SDK, stream, and abort-reason errors may contain credentials or signed URLs.
  return new R2StorageError(
    `R2 ${operation} failed; check the bucket settings, credentials, and connection, then retry.`,
  );
}

function assertSize(sizeBytes: number | undefined, actual: number): void {
  if (sizeBytes !== undefined && sizeBytes !== actual) {
    throw new R2StorageError(
      "R2 object does not match its declared size; provide the exact byte count or omit sizeBytes.",
    );
  }
}

async function* uploadChunks(body: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const iterator = body[Symbol.asyncIterator]();
  let exhausted = false;
  let onAbort: (() => void) | undefined;
  const aborted =
    signal &&
    new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const error = new Error("R2 upload aborted; retry when ready.");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  try {
    while (true) {
      const next = aborted ? await Promise.race([iterator.next(), aborted]) : await iterator.next();
      if (next.done) {
        exhausted = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
    const closing = iterator.return?.();
    if (!exhausted) {
      // A producer blocked in next() or finally cannot delay multipart cleanup.
      // Observe its eventual close without retaining the upload or leaking a rejection.
      void closing?.catch(() => {});
    } else {
      await closing;
    }
  }
}

export function createR2Backend(
  settings: R2Settings,
  client: Pick<S3Client, "send" | "destroy">,
): StorageBackend {
  const namespace = settings.prefix ? `${settings.prefix}/` : "";
  const keyFor = (key: string) => {
    const joined = namespace + key;
    if (Buffer.byteLength(joined) > 1024) {
      throw new R2StorageError(
        "R2 object key exceeds 1024 bytes; shorten the configured prefix or object key.",
      );
    }
    return joined;
  };

  async function multipart(
    Key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { sizeBytes?: number; signal?: AbortSignal },
  ): Promise<{ sizeBytes: number }> {
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket: settings.bucket, Key }),
      { abortSignal: opts.signal },
    );
    if (!UploadId) {
      throw new R2StorageError(
        "R2 did not return an upload ID; check the service status and retry.",
      );
    }
    const upload = { Bucket: settings.bucket, Key, UploadId };
    try {
      const parts: CompletedPart[] = [];
      let sizeBytes = 0;
      let used = 0;
      // Upload sequentially and reuse one part buffer; no queue can retain extra parts.
      const buffer = Buffer.allocUnsafe(PART_BYTES);
      const sendPart = async () => {
        opts.signal?.throwIfAborted();
        if (parts.length === MAX_PARTS) {
          throw new R2StorageError(
            "R2 upload exceeds 10000 parts; split the object into smaller objects.",
          );
        }
        const PartNumber = parts.length + 1;
        const { ETag } = await client.send(
          new UploadPartCommand({
            ...upload,
            PartNumber,
            Body: buffer.subarray(0, used),
            ContentLength: used,
          }),
          { abortSignal: opts.signal },
        );
        if (!ETag) {
          throw new R2StorageError("R2 did not acknowledge an uploaded part; retry the upload.");
        }
        parts.push({ PartNumber, ETag });
        used = 0;
      };
      for await (const chunk of uploadChunks(body, opts.signal)) {
        opts.signal?.throwIfAborted();
        sizeBytes += chunk.byteLength;
        if (opts.sizeBytes !== undefined && sizeBytes > opts.sizeBytes) {
          assertSize(opts.sizeBytes, sizeBytes);
        }
        for (let offset = 0; offset < chunk.byteLength;) {
          const count = Math.min(PART_BYTES - used, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + count), used);
          offset += count;
          used += count;
          if (used === PART_BYTES) {
            await sendPart();
          }
        }
      }
      assertSize(opts.sizeBytes, sizeBytes);
      if (used > 0 || parts.length === 0) {
        await sendPart();
      }
      opts.signal?.throwIfAborted();
      // R2 supports conditional multipart publish (release notes, 2023-08-11).
      // If-None-Match makes completion atomic; a HeadObject pre-check would race.
      await client.send(
        new CompleteMultipartUploadCommand({
          ...upload,
          MultipartUpload: { Parts: parts },
          IfNoneMatch: "*",
        }),
        { abortSignal: opts.signal },
      );
      return { sizeBytes };
    } catch (error) {
      try {
        // Cleanup must still run when the caller's signal has already aborted.
        await client.send(new AbortMultipartUploadCommand(upload));
      } catch (cleanupError) {
        if (!(cleanupError instanceof S3ServiceException && cleanupError.name === "NoSuchUpload")) {
          throw new R2StorageError(
            `${storageError(error, settings, "upload").message} Multipart cleanup also failed; remove incomplete uploads in bucket ${settings.bucket}.`,
          );
        }
      }
      throw error;
    }
  }

  return {
    displayTarget: describeR2Target(settings) ?? `r2://${settings.bucket}`,
    async probe(opts) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: settings.bucket }), {
          abortSignal: opts?.signal,
        });
        return {};
      } catch (error) {
        throw storageError(error, settings, "probe");
      }
    },
    async putObject(key, body, opts) {
      try {
        opts.signal?.throwIfAborted();
        if (
          opts.sizeBytes !== undefined &&
          (!Number.isSafeInteger(opts.sizeBytes) || opts.sizeBytes < 0)
        ) {
          throw new R2StorageError("R2 sizeBytes must be a nonnegative safe integer.");
        }
        const Key = keyFor(key);
        if (opts.sizeBytes === undefined || opts.sizeBytes > PART_BYTES) {
          return await multipart(Key, body, opts);
        }
        const buffer = Buffer.allocUnsafe(opts.sizeBytes);
        let sizeBytes = 0;
        for await (const chunk of uploadChunks(body, opts.signal)) {
          opts.signal?.throwIfAborted();
          if (sizeBytes + chunk.byteLength > buffer.length) {
            assertSize(opts.sizeBytes, sizeBytes + chunk.byteLength);
          }
          buffer.set(chunk, sizeBytes);
          sizeBytes += chunk.byteLength;
        }
        assertSize(opts.sizeBytes, sizeBytes);
        opts.signal?.throwIfAborted();
        await client.send(
          new PutObjectCommand({
            Bucket: settings.bucket,
            Key,
            Body: buffer,
            ContentLength: sizeBytes,
            IfNoneMatch: "*",
          }),
          { abortSignal: opts.signal },
        );
        return { sizeBytes };
      } catch (error) {
        throw storageError(error, settings, "upload");
      }
    },
    async getObject(key, opts) {
      try {
        const { Body } = await client.send(
          new GetObjectCommand({ Bucket: settings.bucket, Key: keyFor(key) }),
          { abortSignal: opts?.signal },
        );
        if (!Body) {
          throw new R2StorageError("R2 returned no object body; retry the download.");
        }
        const stream = Body.transformToWebStream();
        return (async function* () {
          try {
            for await (const chunk of stream) {
              opts?.signal?.throwIfAborted();
              yield chunk;
            }
          } catch (error) {
            throw storageError(error, settings, "download");
          }
        })();
      } catch (error) {
        if (missingObject(error)) {
          return undefined;
        }
        throw storageError(error, settings, "download");
      }
    },
    async statObject(key, opts) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: settings.bucket, Key: keyFor(key) }),
          { abortSignal: opts?.signal },
        );
        if (result.ContentLength === undefined) {
          throw new R2StorageError("R2 returned no object size; retry the metadata request.");
        }
        return { key, sizeBytes: result.ContentLength, modifiedAt: result.LastModified?.getTime() };
      } catch (error) {
        if (missingObject(error)) {
          return undefined;
        }
        throw storageError(error, settings, "stat");
      }
    },
    async *listObjects(prefix, opts) {
      try {
        const Prefix = keyFor(prefix);
        let ContinuationToken: string | undefined;
        do {
          opts?.signal?.throwIfAborted();
          const page = await client.send(
            new ListObjectsV2Command({ Bucket: settings.bucket, Prefix, ContinuationToken }),
            { abortSignal: opts?.signal },
          );
          for (const object of page.Contents ?? []) {
            if (
              object.Key === undefined ||
              object.Size === undefined ||
              !object.Key.startsWith(Prefix)
            ) {
              throw new R2StorageError("R2 returned invalid object metadata; retry the listing.");
            }
            yield {
              key: object.Key.slice(namespace.length),
              sizeBytes: object.Size,
              modifiedAt: object.LastModified?.getTime(),
            };
          }
          const next = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && (!next || next === ContinuationToken)) {
            throw new R2StorageError("R2 did not advance its listing cursor; retry the listing.");
          }
          ContinuationToken = next;
        } while (ContinuationToken);
      } catch (error) {
        throw storageError(error, settings, "list");
      }
    },
    async deleteObject(key, opts) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: keyFor(key) }), {
          abortSignal: opts?.signal,
        });
      } catch (error) {
        throw storageError(error, settings, "delete");
      }
    },
    async close() {
      client.destroy();
    },
  };
}
