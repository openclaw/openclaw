/// <reference lib="esnext.array" />
/// <reference lib="es2024.promise" />
import { ReadableStream } from "node:stream/web";
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
  yield* chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk));
}

function fixture(...responses: unknown[]) {
  const send = vi.fn();
  responses.forEach((response) =>
    response instanceof Error
      ? send.mockRejectedValueOnce(response)
      : send.mockResolvedValueOnce(response),
  );
  const backend = createR2Backend(settings, { send, destroy: vi.fn() });
  return {
    send,
    backend,
    put: (body: AsyncIterable<Uint8Array>, opts: Parameters<typeof backend.putObject>[2] = {}) =>
      backend.putObject("object", body, opts),
    get: (opts?: Parameters<typeof backend.getObject>[1]) => backend.getObject("object", opts),
    read: async () => Array.fromAsync((await backend.getObject("object"))!),
  };
}

async function* interrupted(chunk: string, code?: string) {
  yield Buffer.from(chunk);
  throw Object.assign(new Error(PRIVATE), { code });
}

function multipartFixture(part = (_command: s3.UploadPartCommand) => ({ ETag: "part" })) {
  const context = fixture();
  context.send.mockImplementation(async (command) => {
    if (command instanceof s3.CreateMultipartUploadCommand) {
      return { UploadId: "upload" };
    }
    if (command instanceof s3.UploadPartCommand) {
      return part(command);
    }
    return {};
  });
  return context;
}

const head = (ContentLength: number) => ({ ETag: '"original"', ContentLength });

function download(size: number, start: number, end: number, source: AsyncIterable<Uint8Array>) {
  return {
    ETag: '"original"',
    ContentRange: `bytes ${start}-${end}/${size}`,
    Body: { transformToWebStream: () => ReadableStream.from(source) },
  };
}

async function expectSafeFailure(result: Promise<unknown>, ...messages: string[]) {
  for (const message of messages) {
    await expect(result).rejects.toThrow(message);
  }
  await expect(result).rejects.not.toThrow(PRIVATE);
}

it("conditionally creates small objects and preserves a conflicting object", async () => {
  const { send, put } = fixture({}, serviceError("PreconditionFailed", 412));
  expect(await put(bytes("abc"), { sizeBytes: 3 })).toEqual({ sizeBytes: 3 });
  expect(send.mock.calls[0]?.[0].input).toMatchObject({
    Key: "archive/team/object",
    Body: Buffer.from("abc"),
    IfNoneMatch: "*",
  });
  await expect(put(bytes("new"), { sizeBytes: 3 })).rejects.toThrow("use a new object key");
});

it("uploads ordered bounded parts for a declared large object", async () => {
  const parts: number[][] = [];
  const { send, put } = multipartFixture((command) => {
    const body = command.input.Body;
    if (!(body instanceof Uint8Array)) {
      throw new Error("Expected byte part");
    }
    parts.push([body.byteLength, body[0]!, body[body.byteLength - 1]!]);
    return { ETag: `part-${command.input.PartNumber}` };
  });
  const data = bytes(Buffer.alloc(PART_BYTES - 1, 1), Buffer.from([2, 3, 4, 5]));
  expect(await put(data, { sizeBytes: PART_BYTES + 3 })).toEqual({ sizeBytes: PART_BYTES + 3 });
  expect(parts).toEqual([
    [PART_BYTES, 1, 2],
    [3, 3, 5],
  ]);
  const completion = send.mock.calls.at(-1)?.[0].input;
  expect(completion.IfNoneMatch).toBe("*");
  expect(completion.MultipartUpload.Parts).toEqual(
    [1, 2].map((PartNumber) => ({ PartNumber, ETag: `part-${PartNumber}` })),
  );
});

it("completes an empty unknown-size body through multipart", async () => {
  const { send, put } = fixture({ UploadId: "upload" }, { ETag: "empty" }, {});
  expect(await put(bytes())).toEqual({ sizeBytes: 0 });
  expect(send.mock.calls[1]?.[0].input).toMatchObject({ ContentLength: 0, PartNumber: 1 });
  expect(send.mock.calls[2]?.[0]).toBeInstanceOf(s3.CompleteMultipartUploadCommand);
});

it.each(["publish", "source", "size", "cleanup"])("aborts on %s failure", async (failure) => {
  const error =
    failure === "publish" ? serviceError("PreconditionFailed", 412) : new Error(PRIVATE);
  const part = failure === "cleanup" ? error : { ETag: "part" };
  const { send, put } = fixture({ UploadId: "upload" }, part, error, {});
  const result = put(failure === "source" ? interrupted("abc") : bytes("abc"), {
    sizeBytes: failure === "size" ? PART_BYTES + 1 : undefined,
  });
  await expect(result).rejects.not.toThrow(PRIVATE);
  if (failure === "cleanup") {
    await expect(result).rejects.toThrow("remove incomplete uploads in bucket test-bucket");
  }
  expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(s3.AbortMultipartUploadCommand);
  expect(send.mock.calls.at(-1)).toHaveLength(1);
});

it.each(["next", "finally"])("cleans up uploads blocked in %s", async (blocked) => {
  const { send, put } =
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
  const result = put(source(), { signal: controller.signal });
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
});

it("rejects an oversized body before publication", async () => {
  const { send, put } = fixture();
  await expect(put(bytes("abc"), { sizeBytes: 2 })).rejects.toThrow("declared size");
  expect(send).not.toHaveBeenCalled();
});

it.each(["getObject", "statObject", "probe"] as const)("maps missing %s", async (operation) => {
  const { send, backend } = fixture();
  const invoke = () => (operation === "probe" ? backend.probe() : backend[operation]("missing"));
  send.mockRejectedValue(serviceError(operation === "probe" ? "Error" : "NoSuchKey", 404));
  if (operation !== "probe") {
    expect(await invoke()).toBeUndefined();
    send.mockRejectedValue(serviceError("NoSuchBucket", 404));
  }
  await expectSafeFailure(invoke(), `create bucket test-bucket in account ${settings.accountId}`);
});

it("resumes ranged downloads after stream resets, timeouts, and retryable HTTP errors", async () => {
  const { send, read } = fixture(
    head(10),
    download(10, 0, 9, interrupted("abc", "ECONNRESET")),
    serviceError("ServiceUnavailable", 503),
    download(10, 3, 9, interrupted("de", "ETIMEDOUT")),
    download(10, 5, 9, bytes("fghij")),
  );
  expect(Buffer.concat(await read()).toString()).toBe("abcdefghij");
  expect(send.mock.calls.slice(1).map(([{ input }]) => [input.Range, input.IfMatch])).toEqual(
    [0, 3, 3, 5].map((offset) => [`bytes=${offset}-9`, '"original"']),
  );
});

it("advances bounded ranges and resumes a short response without duplicating bytes", async () => {
  const { send, read } = fixture(
    head(PART_BYTES + 3),
    download(PART_BYTES + 3, 0, PART_BYTES - 1, bytes(Buffer.alloc(PART_BYTES))),
    download(PART_BYTES + 3, PART_BYTES, PART_BYTES + 2, bytes("a")),
    download(PART_BYTES + 3, PART_BYTES + 1, PART_BYTES + 2, bytes("bc")),
  );
  const chunks = await read();
  expect(chunks.map((chunk) => chunk.byteLength)).toEqual([PART_BYTES, 1, 2]);
  expect(Buffer.concat(chunks.slice(1)).toString()).toBe("abc");
  expect(send.mock.calls.slice(1).map(([command]) => command.input.Range)).toEqual([
    `bytes=0-${PART_BYTES - 1}`,
    `bytes=${PART_BYTES}-${PART_BYTES + 2}`,
    `bytes=${PART_BYTES + 1}-${PART_BYTES + 2}`,
  ]);
});

it.each(["stream", "precondition", "etag", "range"])("rejects download %s", async (failure) => {
  const source = interrupted("abc", failure === "stream" ? undefined : "ECONNRESET");
  const { send, read } = fixture(head(6), download(6, 0, 5, source));
  if (failure === "precondition") {
    send.mockRejectedValueOnce(serviceError("PreconditionFailed", 412));
  } else if (failure !== "stream") {
    send.mockResolvedValueOnce({
      ...download(6, failure === "range" ? 0 : 3, 5, bytes("def")),
      ETag: failure === "etag" ? '"replacement"' : '"original"',
    });
  }
  await expectSafeFailure(
    read(),
    failure === "stream"
      ? "R2 download failed"
      : failure === "range"
        ? "unexpected byte range"
        : "object changed",
    "after 3 of 6 bytes (next offset 3)",
  );
});

it("bounds stalled download retries and includes a safe cause and byte offset", async () => {
  const { send, read } = fixture(head(6));
  send.mockRejectedValue(Object.assign(new Error(PRIVATE), { code: "ECONNRESET" }));
  await expectSafeFailure(read(), "after 0 of 6 bytes (next offset 0; ECONNRESET)");
  expect(send).toHaveBeenCalledTimes(10);
});

it("does not retry permission errors or an aborted download", async () => {
  const { send, get } = fixture(head(6));
  send.mockRejectedValueOnce(serviceError("AccessDenied", 403));
  const denied = await get();
  await expect(Array.fromAsync(denied!)).rejects.toThrow("R2 access denied");
  expect(send).toHaveBeenCalledTimes(2);

  const controller = new AbortController();
  send.mockResolvedValueOnce(head(6));
  const aborted = await get({ signal: controller.signal });
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
  expect(send.mock.calls[0]?.[0].input.Prefix).toBe("archive/team/backups/");
  expect(send.mock.calls[1]?.[0].input.ContinuationToken).toBe("next");
});

it("reports object size and modification time", async () => {
  const { backend } = fixture({ ContentLength: 42, LastModified: new Date(1000) });
  const info = await backend.statObject("object");
  expect(info).toEqual({ key: "object", sizeBytes: 42, modifiedAt: 1000 });
});
