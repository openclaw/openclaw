import crypto from "node:crypto";
import fs from "node:fs/promises";
import { assert, describe, expect, it, vi } from "vitest";
import { FILE_FETCH_CHUNK_BYTES } from "../shared/file-fetch-protocol.js";
import { handleFileFetch } from "./file-fetch.js";
import { duplexPeer, useFiles } from "./node-host.test-support.js";

const { at, file: makeFile } = useFiles("file-fetch-test-", vi.restoreAllMocks);
type FetchResult = Awaited<ReturnType<typeof handleFileFetch>>;
function expectFailureCode(
  result: FetchResult,
  code: string,
): asserts result is Extract<FetchResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}
function expectSuccess(result: FetchResult): asserts result is Extract<FetchResult, { ok: true }> {
  expect(result.ok).toBe(true);
}
async function fetchFile(name: string, content: string | Buffer) {
  const result = await handleFileFetch({ path: await makeFile(name, content) });
  expectSuccess(result);
  return result;
}
describe("handleFileFetch", () => {
  it.each([
    ["relative/file.txt", /absolute/],
    ["/tmp/foo\0bar", /NUL/],
  ])("rejects invalid path %j", async (path, message) => {
    const r = await handleFileFetch({ path });
    expectFailureCode(r, "INVALID_PATH");
    expect(r.message).toMatch(message);
  });
  it("returns IS_DIRECTORY when the path resolves to a directory", async () => {
    const r = await handleFileFetch({ path: at() });
    expectFailureCode(r, "IS_DIRECTORY");
    expect(r.canonicalPath).toBe(at());
  });
  it.each([
    ["empty.png", "", "image/png"],
    ["LICENSE", "Permission is hereby granted\n", "text/plain"],
    ["opaque", Buffer.from([0x00, 0x01, 0x02, 0xff]), "application/octet-stream"],
  ])("fetches %s with detected MIME and exact bytes", async (name, content, mimeType) => {
    const result = await fetchFile(name, content);
    expect(result).toMatchObject({
      mimeType,
      size: Buffer.byteLength(content),
      base64: Buffer.from(content).toString("base64"),
    });
    if (name === "empty.png") {
      expect(result.sha256).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }
  });
  it.runIf(process.platform !== "win32")(
    "rejects a retargeted path before reading file bytes",
    async () => {
      const first = await makeFile("first.txt", "approved");
      const second = await makeFile("second.txt", "not approved");
      const link = at("current.txt");
      await fs.symlink(first, link);

      const preflight = await handleFileFetch({
        path: link,
        followSymlinks: true,
        preflightOnly: true,
      });
      expectSuccess(preflight);
      await fs.unlink(link);
      await fs.symlink(second, link);

      const result = await handleFileFetch({
        path: link,
        followSymlinks: true,
        expectedCanonicalPath: preflight.path,
      });

      expectFailureCode(result, "CANONICAL_PATH_CHANGED");
      expect(result.canonicalPath).toBe(second);
    },
  );

  it("rejects a replacement at the same canonical pathname before reading bytes", async () => {
    const target = await makeFile("target.txt", "approved");
    const readFileSpy = vi.spyOn(fs, "readFile");
    const preflight = await handleFileFetch({ path: target, preflightOnly: true });
    expectSuccess(preflight);
    expect(preflight).toMatchObject({ base64: "", sha256: "", preflightOnly: true });
    expect(readFileSpy).not.toHaveBeenCalled();
    await fs.rename(target, at("moved.txt"));
    await fs.writeFile(target, "not approved");

    const result = await handleFileFetch({
      path: target,
      expectedCanonicalPath: preflight.path,
      expectedBinding: preflight.binding,
    });

    expectFailureCode(result, "CANONICAL_PATH_CHANGED");
    expect(await fs.readFile(target, "utf8")).toBe("not approved");
  });

  it("bounds bytes consumed when a file grows after the size check", async () => {
    const target = await makeFile("growing.txt", "small");
    const realOpen = fs.open.bind(fs);
    let bytesRead = 0;
    let grown = false;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (String(file) === target) {
        const read = handle.read.bind(handle);
        // Keep real filesystem reads; append only after the handler has checked size.
        handle.read = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          if (!grown) {
            grown = true;
            await fs.appendFile(target, Buffer.alloc(1024));
          }
          const result = await read(buffer, offset, length, position);
          bytesRead += result.bytesRead;
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });

    expectFailureCode(await handleFileFetch({ path: target, maxBytes: 8 }), "FILE_TOO_LARGE");
    expect(grown).toBe(true);
    expect(bytesRead).toBeGreaterThan(8);
    expect(bytesRead).toBeLessThanOrEqual(9);
  });

  it("clamps maxBytes to the hard ceiling", async () => {
    const target = await makeFile("oversized.bin", "");
    await fs.truncate(target, 16 * 1024 * 1024 + 1);

    const r = await handleFileFetch({ path: target, maxBytes: Number.MAX_SAFE_INTEGER });
    expectFailureCode(r, "FILE_TOO_LARGE");
    expect(r.message).toContain("limit 16777216");
  });

  it("uses default cap when maxBytes is not finite or non-positive", async () => {
    const target = await makeFile("above-default.bin", "");
    await fs.truncate(target, 8 * 1024 * 1024 + 1);

    for (const maxBytes of [-1, Number.NaN, "8"] as unknown[]) {
      const r = await handleFileFetch({ path: target, maxBytes });
      expectFailureCode(r, "FILE_TOO_LARGE");
      expect(r.message).toContain("limit 8388608");
    }
  });
  it("refuses to follow a symlink by default (SYMLINK_REDIRECT)", async () => {
    const real = await makeFile("real.txt", "data");
    const link = at("link.txt");
    await fs.symlink(real, link);

    const r = await handleFileFetch({ path: link });
    expectFailureCode(r, "SYMLINK_REDIRECT");
    expect(r.canonicalPath).toBe(real);
  });
});

async function binaryFixture(bytes = Buffer.from("output")) {
  const target = await makeFile("output.bin", bytes);
  const params = { path: target, transport: "binary", maxBytes: bytes.length };
  const preflight = await handleFileFetch({ ...params, preflightOnly: true });
  assert(preflight.ok, JSON.stringify(preflight));
  const peer = duplexPeer();
  const chunks: Buffer[] = [];
  const onChunk = vi.fn(async () => {});
  peer.send.mockImplementation(async (message) => {
    expect(message.byteLength).toBeLessThanOrEqual(FILE_FETCH_CHUNK_BYTES);
    chunks.push(Buffer.from(message));
    await onChunk();
    await peer.receive(Buffer.from("ack"));
  });
  const { binding: expectedBinding, path: expectedCanonicalPath } = preflight;
  const send = (control: string) => peer.receive(Buffer.from(control));
  const start = () =>
    handleFileFetch({ ...params, expectedBinding, expectedCanonicalPath }, peer.io);
  return { ...peer, target, bytes, preflight, chunks, onChunk, send, start };
}

it("preflights without a stream and sends bounded chunks from the authorized handle after START", async () => {
  const value = await binaryFixture(Buffer.alloc(17 * 1024 * 1024, 0x5a));
  expect(value.preflight).toMatchObject({ preflightOnly: true, base64: "", sha256: "" });
  const pending = value.start();
  await value.ready;
  expect(value.chunks).toHaveLength(0);
  await fs.rename(value.target, `${value.target}.old`);
  await fs.writeFile(value.target, "other");
  await value.send("start");
  expect(await pending).toMatchObject({
    ok: true,
    transport: "binary",
    base64: "",
    size: value.bytes.length,
    sha256: crypto.createHash("sha256").update(value.bytes).digest("hex"),
  });
  expect(Buffer.concat(value.chunks).equals(value.bytes)).toBe(true);
  await expect(value.send("ack")).rejects.toThrow("No receiver");
});

it("preserves unary result shape even when optional duplex IO is supplied", async () => {
  const value = await binaryFixture();
  const result = await handleFileFetch({ path: value.target }, value.io);
  expect(result).toMatchObject({ ok: true, base64: value.bytes.toString("base64") });
  expect(result).not.toHaveProperty("transport");
  expect(value.chunks).toHaveLength(0);
  await expect(value.send("start")).rejects.toThrow("No receiver");
});

it.each([
  ["growth", "FILE_TOO_LARGE", FILE_FETCH_CHUNK_BYTES],
  ["cancellation", "READ_ERROR", 0],
] as const)("bounds output and releases the stream after %s", async (mode, code, size) => {
  const value = await binaryFixture(Buffer.alloc(FILE_FETCH_CHUNK_BYTES));
  const realOpen = fs.open.bind(fs);
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    closes.push(vi.spyOn(handle, "close"));
    return handle;
  });
  value.onChunk.mockImplementationOnce(() => fs.appendFile(value.target, "x"));
  const pending = value.start();
  await value.ready;
  if (mode === "growth") {
    await value.send("start");
  } else {
    value.controller.abort(new Error("revoked"));
  }
  expect(await pending).toMatchObject({ ok: false, code });
  expect(closes.length).toBeGreaterThan(0);
  closes.forEach((close) => expect(close).toHaveBeenCalledOnce());
  await expect(value.send("start")).rejects.toThrow("No receiver");
  expect(Buffer.concat(value.chunks)).toHaveLength(size);
  expect(value.chunks.length > 0).toBe(mode === "growth");
});

it.each([undefined, -1, Number.MAX_SAFE_INTEGER + 1])("invalid budget: %s", async (maxBytes) => {
  const result = await handleFileFetch({ path: "/unused", transport: "binary", maxBytes });
  expect(result).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
});
