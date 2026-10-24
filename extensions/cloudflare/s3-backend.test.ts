/// <reference lib="esnext.array" />
/// <reference lib="es2024.promise" />
import * as s3 from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { createR2Backend } from "./s3-backend.js";
import type { R2Settings } from "./settings.js";

const PART_BYTES = 64 * 1024 * 1024;
const PRIVATE = "private-credential-value";
const settings: R2Settings = {
  accountId: "0".repeat(32),
  bucket: "test-bucket",
  prefix: "archive/team",
  accessKeyId: { source: "env", provider: "default", id: "R2_KEY" },
  secretAccessKey: { source: "env", provider: "default", id: "R2_SECRET" },
};

function serviceError(name: string, code: number) {
  return new s3.S3ServiceException({
    name,
    $fault: "client",
    $metadata: { httpStatusCode: code },
    message: PRIVATE,
  });
}

async function* bytes(...chunks: (Uint8Array | string)[]) {
  for (const chunk of chunks) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

function fixture(...responses: unknown[]) {
  const send = vi.fn();
  responses.forEach((response) =>
    response instanceof Error
      ? send.mockRejectedValueOnce(response)
      : send.mockResolvedValueOnce(response),
  );
  const destroy = vi.fn();
  return { send, destroy, backend: createR2Backend(settings, { send, destroy }) };
}

async function* interrupted(chunk: string, code?: string) {
  yield Buffer.from(chunk);
  throw Object.assign(new Error(PRIVATE), { code });
}

function multipartFixture(
  part = (_command: s3.UploadPartCommand) => ({ ETag: "part" }),
  complete = () => ({}),
) {
  const context = fixture();
  context.send.mockImplementation(async (command) => {
    if (command instanceof s3.CreateMultipartUploadCommand) {
      return { UploadId: "upload" };
    }
    if (command instanceof s3.UploadPartCommand) {
      return part(command);
    }
    return command instanceof s3.CompleteMultipartUploadCommand ? complete() : {};
  });
  return context;
}

const head = (ContentLength: number) => ({ ETag: '"original"', ContentLength });
const target = (key: string) => ({ Bucket: "test-bucket", Key: `archive/team/${key}` });

function expectCommand(command: { input: unknown }, type: unknown, input: unknown) {
  expect(command).toBeInstanceOf(type);
  expect(command.input).toEqual(input);
}

function download(size: number, start: number, end: number, source: AsyncIterable<Uint8Array>) {
  return {
    ETag: '"original"',
    ContentRange: `bytes ${start}-${end}/${size}`,
    Body: {
      transformToWebStream() {
        const iterator = source[Symbol.asyncIterator]();
        return new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              const next = await iterator.next();
              if (next.done) {
                controller.close();
              } else {
                controller.enqueue(next.value);
              }
            },
            async cancel() {
              await iterator.return?.();
            },
          },
          { highWaterMark: 0 },
        );
      },
    },
  };
}

async function expectSafeFailure(result: Promise<unknown>, ...messages: string[]) {
  for (const message of messages) {
    await expect(result).rejects.toThrow(message);
  }
  await expect(result).rejects.not.toThrow(PRIVATE);
}

it("conditionally creates small objects and preserves a conflicting object", async () => {
  const { send, backend } = fixture();
  send.mockResolvedValueOnce({}).mockRejectedValueOnce(serviceError("PreconditionFailed", 412));
  expect(await backend.putObject("backup.tar", bytes("abc"), { sizeBytes: 3 })).toEqual({
    sizeBytes: 3,
  });
  expectCommand(send.mock.calls[0]?.[0], s3.PutObjectCommand, {
    ...target("backup.tar"),
    Body: Buffer.from("abc"),
    ContentLength: 3,
    IfNoneMatch: "*",
  });
  await expect(backend.putObject("backup.tar", bytes("new"), { sizeBytes: 3 })).rejects.toThrow(
    "use a new object key",
  );
  expect(send).toHaveBeenCalledTimes(2);
});

it("uploads ordered bounded parts for a declared large object", async () => {
  const parts: number[][] = [];
  const { send, backend } = multipartFixture((command) => {
    const body = command.input.Body;
    if (!(body instanceof Uint8Array)) {
      throw new Error("Expected byte part");
    }
    parts.push([body.byteLength, body[0]!, body[body.byteLength - 1]!]);
    return { ETag: `part-${command.input.PartNumber}` };
  });
  const data = bytes(Buffer.alloc(PART_BYTES - 1, 1), Buffer.from([2, 3, 4, 5]));
  expect(await backend.putObject("large", data, { sizeBytes: PART_BYTES + 3 })).toEqual({
    sizeBytes: PART_BYTES + 3,
  });
  expect(parts).toEqual([
    [PART_BYTES, 1, 2],
    [3, 3, 5],
  ]);
  expectCommand(send.mock.calls.at(-1)?.[0], s3.CompleteMultipartUploadCommand, {
    ...target("large"),
    UploadId: "upload",
    IfNoneMatch: "*",
    MultipartUpload: {
      Parts: [
        { PartNumber: 1, ETag: "part-1" },
        { PartNumber: 2, ETag: "part-2" },
      ],
    },
  });
});

it("completes an empty unknown-size body through multipart", async () => {
  const { send, backend } = fixture({ UploadId: "upload" }, { ETag: "empty" }, {});
  expect(await backend.putObject("empty", bytes(), {})).toEqual({ sizeBytes: 0 });
  expect(send.mock.calls[1]?.[0].input).toMatchObject({ ContentLength: 0, PartNumber: 1 });
  expect(send.mock.calls[2]?.[0]).toBeInstanceOf(s3.CompleteMultipartUploadCommand);
});

it.each(["completion", "producer", "size"])("aborts multipart when %s fails", async (failure) => {
  const { send, backend } = multipartFixture(undefined, () => {
    if (failure === "completion") {
      throw serviceError("PreconditionFailed", 412);
    }
    return {};
  });
  async function* source() {
    yield Buffer.from("abc");
    if (failure === "producer") {
      throw new Error(PRIVATE);
    }
  }
  const result = backend.putObject("broken", source(), {
    sizeBytes: failure === "size" ? PART_BYTES + 1 : undefined,
  });
  await expect(result).rejects.not.toThrow(PRIVATE);
  expectCommand(send.mock.calls.at(-1)?.[0], s3.AbortMultipartUploadCommand, {
    ...target("broken"),
    UploadId: "upload",
  });
  expect(send.mock.calls.at(-1)).toHaveLength(1);
});

it.each(["next", "finally"])(
  "cleans up uploads without waiting for blocked %s",
  async (blocked) => {
    const { send, backend } =
      blocked === "next"
        ? fixture({ UploadId: "upload" }, { ETag: "part" }, {})
        : multipartFixture(() => {
            throw serviceError("AccessDenied", 403);
          });
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    async function* source() {
      try {
        yield Buffer.alloc(PART_BYTES);
        started.resolve();
        await waiting.promise;
        yield Buffer.from("late");
      } finally {
        await waiting.promise;
      }
    }
    const result = backend.putObject("blocked", source(), { signal: controller.signal });
    const rejected =
      blocked === "next"
        ? expect(result).rejects.toMatchObject({ name: "AbortError" })
        : expectSafeFailure(result, "Object Read & Write");
    try {
      if (blocked === "next") {
        await started.promise;
        controller.abort();
      }
      await rejected;
      expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(s3.AbortMultipartUploadCommand);
      expect(send.mock.calls.at(-1)).toHaveLength(1);
      expect(
        send.mock.calls.some(([command]) => command instanceof s3.CompleteMultipartUploadCommand),
      ).toBe(false);
    } finally {
      waiting.resolve();
    }
  },
);

it("reports cleanup failures without exposing the underlying error", async () => {
  const { send, backend } = fixture({ UploadId: "upload" });
  send.mockRejectedValue(new Error(PRIVATE));
  await expect(backend.putObject("broken", bytes("abc"), {})).rejects.toThrow(
    "remove incomplete uploads in bucket test-bucket",
  );
});

it("rejects an oversized body before publication", async () => {
  const { send, backend } = fixture();
  await expect(backend.putObject("wrong-size", bytes("abc"), { sizeBytes: 2 })).rejects.toThrow(
    "declared size",
  );
  expect(send).not.toHaveBeenCalled();
});

it.each(["getObject", "statObject", "probe"] as const)(
  "maps missing targets in %s",
  async (operation) => {
    const { send, backend } = fixture();
    const invoke = () => (operation === "probe" ? backend.probe() : backend[operation]("missing"));
    send.mockRejectedValue(serviceError(operation === "probe" ? "Error" : "NoSuchKey", 404));
    if (operation !== "probe") {
      expect(await invoke()).toBeUndefined();
      send.mockRejectedValue(serviceError("NoSuchBucket", 404));
    }
    await expectSafeFailure(invoke(), `create bucket test-bucket in account ${settings.accountId}`);
    if (operation === "probe") {
      send.mockRejectedValue(serviceError("Error", 500));
      await expectSafeFailure(invoke(), "check the bucket settings");
    }
  },
);

it("resumes ranged downloads after stream resets, timeouts, and retryable HTTP errors", async () => {
  const { send, backend } = fixture(
    head(10),
    download(10, 0, 9, interrupted("abc", "ECONNRESET")),
    serviceError("ServiceUnavailable", 503),
    download(10, 3, 9, interrupted("de", "ETIMEDOUT")),
    download(10, 5, 9, bytes("fghij")),
  );
  const body = await backend.getObject("object");
  expect(Buffer.concat(await Array.fromAsync(body!)).toString()).toBe("abcdefghij");
  expect(send).toHaveBeenCalledTimes(5);
  for (const [index, [command]] of send.mock.calls.slice(1).entries()) {
    expectCommand(command, s3.GetObjectCommand, {
      ...target("object"),
      IfMatch: '"original"',
      Range: `bytes=${[0, 3, 3, 5][index]}-9`,
    });
  }
});

it("advances bounded ranges and resumes a short response without duplicating bytes", async () => {
  const { send, backend } = fixture(
    head(PART_BYTES + 3),
    download(PART_BYTES + 3, 0, PART_BYTES - 1, bytes(Buffer.alloc(PART_BYTES))),
    download(PART_BYTES + 3, PART_BYTES, PART_BYTES + 2, bytes("a")),
    download(PART_BYTES + 3, PART_BYTES + 1, PART_BYTES + 2, bytes("bc")),
  );
  const body = await backend.getObject("object");
  const chunks = await Array.fromAsync(body!);
  expect(chunks.map((chunk) => chunk.byteLength)).toEqual([PART_BYTES, 1, 2]);
  expect(Buffer.concat(chunks.slice(1)).toString()).toBe("abc");
  expect(send.mock.calls.slice(1).map(([command]) => command.input.Range)).toEqual([
    `bytes=0-${PART_BYTES - 1}`,
    `bytes=${PART_BYTES}-${PART_BYTES + 2}`,
    `bytes=${PART_BYTES + 1}-${PART_BYTES + 2}`,
  ]);
});

it.each(["stream", "precondition", "etag", "range"])(
  "rejects invalid download %s",
  async (failure) => {
    const source = interrupted("abc", failure === "stream" ? undefined : "ECONNRESET");
    const { send, backend } = fixture(head(6), download(6, 0, 5, source));
    if (failure === "precondition") {
      send.mockRejectedValueOnce(serviceError("PreconditionFailed", 412));
    } else if (failure !== "stream") {
      send.mockResolvedValueOnce({
        ...download(6, failure === "range" ? 0 : 3, 5, bytes("def")),
        ETag: failure === "etag" ? '"replacement"' : '"original"',
      });
    }
    const body = await backend.getObject("object");
    const iterator = body![Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: Buffer.from("abc") });
    const rejected = iterator.next();
    await expectSafeFailure(
      rejected,
      failure === "stream"
        ? "R2 download failed"
        : failure === "range"
          ? "unexpected byte range"
          : "object changed",
      "after 3 of 6 bytes (next offset 3)",
    );
    expect(send).toHaveBeenCalledTimes(failure === "stream" ? 2 : 3);
  },
);

it("bounds stalled download retries and includes a safe cause and byte offset", async () => {
  const { send, backend } = fixture(head(6));
  send.mockRejectedValue(Object.assign(new Error(PRIVATE), { code: "ECONNRESET" }));
  const body = await backend.getObject("object");
  const rejected = Array.fromAsync(body!);
  await expectSafeFailure(rejected, "after 0 of 6 bytes (next offset 0; ECONNRESET)");
  expect(send).toHaveBeenCalledTimes(10);
});

it("does not retry permission errors or an aborted download", async () => {
  const { send, backend } = fixture(head(6));
  send.mockRejectedValueOnce(serviceError("AccessDenied", 403));
  const denied = await backend.getObject("object");
  await expect(Array.fromAsync(denied!)).rejects.toThrow("R2 access denied");
  expect(send).toHaveBeenCalledTimes(2);

  const controller = new AbortController();
  send.mockResolvedValueOnce(head(6));
  const aborted = await backend.getObject("object", { signal: controller.signal });
  controller.abort();
  await expect(Array.fromAsync(aborted!)).rejects.toMatchObject({ name: "AbortError" });
  expect(send).toHaveBeenCalledTimes(3);
});

it("paginates within the configured namespace and returns relative keys", async () => {
  const { send, backend } = fixture(
    {
      Contents: [{ Key: "archive/team/backups/one", Size: 1, LastModified: new Date(1000) }],
      IsTruncated: true,
      NextContinuationToken: "next",
    },
    { Contents: [{ Key: "archive/team/backups/two", Size: 2 }] },
  );
  expect(await Array.fromAsync(backend.listObjects("backups/"))).toEqual([
    { key: "backups/one", sizeBytes: 1, modifiedAt: 1000 },
    { key: "backups/two", sizeBytes: 2, modifiedAt: undefined },
  ]);
  expectCommand(send.mock.calls[0]?.[0], s3.ListObjectsV2Command, {
    Bucket: "test-bucket",
    Prefix: "archive/team/backups/",
    ContinuationToken: undefined,
  });
  expect(send.mock.calls[1]?.[0].input.ContinuationToken).toBe("next");
});

it("stats, probes, deletes, and closes the client", async () => {
  const { send, destroy, backend } = fixture({ ContentLength: 42, LastModified: new Date(1000) });
  send.mockResolvedValue({});
  expect(await backend.statObject("object")).toEqual({
    key: "object",
    sizeBytes: 42,
    modifiedAt: 1000,
  });
  expect(await backend.probe()).toEqual({});
  await backend.deleteObject("object");
  await backend.close?.();
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(s3.HeadObjectCommand);
  expect(send.mock.calls[1]?.[0]).toBeInstanceOf(s3.HeadBucketCommand);
  expectCommand(send.mock.calls[2]?.[0], s3.DeleteObjectCommand, target("object"));
  expect(destroy).toHaveBeenCalledOnce();
  expect(backend.displayTarget).toBe("r2://test-bucket/archive/team");
});
