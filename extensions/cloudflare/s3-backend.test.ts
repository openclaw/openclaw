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
} from "@aws-sdk/client-s3";
import type { StorageObjectInfo } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createR2Backend } from "./s3-backend.js";
import type { R2Settings } from "./settings.js";

const PART_BYTES = 64 * 1024 * 1024;
const settings: R2Settings = {
  accountId: "0".repeat(32),
  bucket: "test-bucket",
  prefix: "archive/team",
  accessKeyId: { source: "env", provider: "default", id: "R2_KEY" },
  secretAccessKey: { source: "env", provider: "default", id: "R2_SECRET" },
};

function serviceError(name: string, code: number) {
  return new S3ServiceException({
    name,
    $fault: "client",
    $metadata: { httpStatusCode: code },
    message: "private-credential-value",
  });
}

async function* bytes(...chunks: Uint8Array[]) {
  yield* chunks;
}

function fixture() {
  const send = vi.fn();
  const destroy = vi.fn();
  return { send, destroy, backend: createR2Backend(settings, { send, destroy }) };
}

describe("R2 object transport", () => {
  it("conditionally creates small objects and preserves a conflicting object", async () => {
    const { send, backend } = fixture();
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(serviceError("PreconditionFailed", 412));
    expect(
      await backend.putObject("backup.tar", bytes(Buffer.from("abc")), { sizeBytes: 3 }),
    ).toEqual({ sizeBytes: 3 });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "test-bucket",
      Key: "archive/team/backup.tar",
      Body: Buffer.from("abc"),
      ContentLength: 3,
      IfNoneMatch: "*",
    });
    await expect(
      backend.putObject("backup.tar", bytes(Buffer.from("new")), { sizeBytes: 3 }),
    ).rejects.toThrow("use a new object key");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([0, PART_BYTES])("uses conditional PutObject for known size %i", async (sizeBytes) => {
    const { send, backend } = fixture();
    send.mockResolvedValue({});
    expect(
      await backend.putObject("boundary", bytes(Buffer.alloc(sizeBytes)), { sizeBytes }),
    ).toEqual({ sizeBytes });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      ContentLength: sizeBytes,
      IfNoneMatch: "*",
    });
  });

  it.each([undefined, PART_BYTES + 3])(
    "uploads ordered bounded parts with declared size %s",
    async (sizeBytes) => {
      const { send, backend } = fixture();
      const lengths: number[] = [];
      const edges: number[][] = [];
      send.mockImplementation(async (command) => {
        if (command instanceof CreateMultipartUploadCommand) {
          return { UploadId: "upload" };
        }
        if (command instanceof UploadPartCommand) {
          const body = command.input.Body;
          if (!(body instanceof Uint8Array)) {
            throw new Error("Expected byte part");
          }
          lengths.push(body.byteLength);
          edges.push([body[0]!, body[body.byteLength - 1]!]);
          return { ETag: `part-${command.input.PartNumber}` };
        }
        return {};
      });
      const data = bytes(Buffer.alloc(PART_BYTES - 1, 1), Buffer.from([2, 3, 4, 5]));
      expect(await backend.putObject("large", data, { sizeBytes })).toEqual({
        sizeBytes: PART_BYTES + 3,
      });
      expect(lengths).toEqual([PART_BYTES, 3]);
      expect(edges).toEqual([
        [1, 2],
        [3, 5],
      ]);
      const complete = send.mock.calls.at(-1)?.[0];
      expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(complete.input).toEqual({
        Bucket: "test-bucket",
        Key: "archive/team/large",
        UploadId: "upload",
        IfNoneMatch: "*",
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: "part-1" },
            { PartNumber: 2, ETag: "part-2" },
          ],
        },
      });
    },
  );

  it("completes an empty unknown-size body through multipart", async () => {
    const { send, backend } = fixture();
    send
      .mockResolvedValueOnce({ UploadId: "upload" })
      .mockResolvedValueOnce({ ETag: "empty" })
      .mockResolvedValueOnce({});
    expect(await backend.putObject("empty", bytes(), {})).toEqual({ sizeBytes: 0 });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({ ContentLength: 0, PartNumber: 1 });
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(CompleteMultipartUploadCommand);
  });

  it.each(["part", "completion", "producer", "size"])(
    "aborts multipart when %s fails",
    async (failure) => {
      const { send, backend } = fixture();
      send.mockImplementation(async (command) => {
        if (command instanceof CreateMultipartUploadCommand) {
          return { UploadId: "upload" };
        }
        if (command instanceof UploadPartCommand) {
          if (failure === "part") {
            throw serviceError("AccessDenied", 403);
          }
          return { ETag: "part" };
        }
        if (command instanceof CompleteMultipartUploadCommand && failure === "completion") {
          throw serviceError("PreconditionFailed", 412);
        }
        return {};
      });
      async function* source() {
        yield Buffer.from("abc");
        if (failure === "producer") {
          throw new Error("private-credential-value");
        }
      }
      const result = backend.putObject("broken", source(), {
        sizeBytes: failure === "size" ? PART_BYTES + 1 : undefined,
      });
      await expect(result).rejects.not.toThrow("private-credential-value");
      expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(send.mock.calls.at(-1)?.[0].input).toEqual({
        Bucket: "test-bucket",
        Key: "archive/team/broken",
        UploadId: "upload",
      });
      expect(send.mock.calls.at(-1)).toHaveLength(1);
    },
  );

  it("aborts a cancelled multipart upload without passing the cancelled signal to cleanup", async () => {
    const { send, backend } = fixture();
    const controller = new AbortController();
    send.mockImplementation(async (command) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return { UploadId: "upload" };
      }
      if (command instanceof UploadPartCommand) {
        controller.abort();
        throw controller.signal.reason;
      }
      return {};
    });
    await expect(
      backend.putObject("cancelled", bytes(Buffer.from("abc")), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
    expect(send.mock.calls.at(-1)).toHaveLength(1);
    expect(
      send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand),
    ).toBe(false);
  });

  it("cancels a blocked producer and cleans up its upload", async () => {
    const { send, backend } = fixture();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    send.mockResolvedValueOnce({ UploadId: "upload" }).mockResolvedValue({});
    async function* source() {
      entered?.();
      await waiting;
      yield Buffer.from("late");
    }
    const result = backend.putObject("blocked", source(), { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      await started;
      controller.abort();
      await rejected;
      expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
    } finally {
      release?.();
    }
  });

  it("aborts a failed part before waiting for producer cleanup", async () => {
    const { send, backend } = fixture();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    send.mockImplementation(async (command) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return { UploadId: "upload" };
      }
      if (command instanceof UploadPartCommand) {
        throw serviceError("AccessDenied", 403);
      }
      return {};
    });
    async function* source() {
      try {
        yield Buffer.alloc(PART_BYTES);
      } finally {
        await waiting;
      }
    }
    try {
      await expect(backend.putObject("failed-part", source(), {})).rejects.toThrow(
        "Object Read & Write",
      );
      expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
    } finally {
      release?.();
    }
  });

  it("reports cleanup failures without exposing the underlying error", async () => {
    const { send, backend } = fixture();
    send
      .mockResolvedValueOnce({ UploadId: "upload" })
      .mockRejectedValue(new Error("private-credential-value"));
    await expect(backend.putObject("broken", bytes(Buffer.from("abc")), {})).rejects.toThrow(
      "remove incomplete uploads in bucket test-bucket",
    );
  });

  it.each([2, 4])("rejects an incorrect known size %i before publication", async (sizeBytes) => {
    const { send, backend } = fixture();
    await expect(
      backend.putObject("wrong-size", bytes(Buffer.from("abc")), { sizeBytes }),
    ).rejects.toThrow("declared size");
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["getObject", "statObject"] as const)(
    "returns undefined for an absent object in %s",
    async (operation) => {
      const { send, backend } = fixture();
      send.mockRejectedValue(serviceError("NoSuchKey", 404));
      expect(await backend[operation]("missing")).toBeUndefined();
      send.mockRejectedValue(serviceError("NoSuchBucket", 404));
      await expect(backend[operation]("missing")).rejects.toThrow(
        `create bucket test-bucket in account ${settings.accountId}`,
      );
    },
  );

  it("streams downloads and sanitizes failures while consuming the body", async () => {
    const { send, backend } = fixture();
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(Buffer.from("first"));
        },
        pull(controller) {
          controller.error(new Error("private-credential-value"));
        },
      },
      { highWaterMark: 0 },
    );
    send.mockResolvedValue({ Body: { transformToWebStream: () => stream } });
    const body = await backend.getObject("object");
    const iterator = body![Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: Buffer.from("first") });
    await expect(iterator.next()).rejects.toThrow("R2 download failed");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("paginates within the configured namespace and returns relative keys", async () => {
    const { send, backend } = fixture();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "archive/team/backups/one", Size: 1, LastModified: new Date(1000) }],
        IsTruncated: true,
        NextContinuationToken: "next",
      })
      .mockResolvedValueOnce({ Contents: [{ Key: "archive/team/backups/two", Size: 2 }] });
    const objects: StorageObjectInfo[] = [];
    for await (const object of backend.listObjects("backups/")) {
      objects.push(object);
    }
    expect(objects).toEqual([
      { key: "backups/one", sizeBytes: 1, modifiedAt: 1000 },
      { key: "backups/two", sizeBytes: 2, modifiedAt: undefined },
    ]);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "test-bucket",
      Prefix: "archive/team/backups/",
      ContinuationToken: undefined,
    });
    expect(send.mock.calls[1]?.[0].input.ContinuationToken).toBe("next");
  });

  it("stats, probes, deletes, and closes the client", async () => {
    const { send, destroy, backend } = fixture();
    send
      .mockResolvedValueOnce({ ContentLength: 42, LastModified: new Date(1000) })
      .mockResolvedValue({});
    expect(await backend.statObject("object")).toEqual({
      key: "object",
      sizeBytes: 42,
      modifiedAt: 1000,
    });
    expect(await backend.probe()).toEqual({});
    await backend.deleteObject("object");
    await backend.close?.();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[2]?.[0].input).toEqual({
      Bucket: "test-bucket",
      Key: "archive/team/object",
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(backend.displayTarget).toBe("r2://test-bucket/archive/team");
  });

  it.each([401, 403, 404, 500])("maps probe HTTP %i into a safe next step", async (code) => {
    const { send, backend } = fixture();
    send.mockRejectedValue(serviceError("Error", code));
    const result = backend.probe();
    await expect(result).rejects.toThrow(
      code === 401 || code === 403
        ? "the R2 token needs Object Read & Write on bucket test-bucket"
        : code === 404
          ? `create bucket test-bucket in account ${settings.accountId}`
          : "check the bucket settings",
    );
    await expect(result).rejects.not.toThrow("private-credential-value");
  });
});
