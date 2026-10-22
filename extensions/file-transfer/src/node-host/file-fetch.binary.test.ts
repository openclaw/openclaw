import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { assert, expect, it, vi } from "vitest";
import { FILE_FETCH_CHUNK_BYTES } from "../shared/file-fetch-protocol.js";
import { handleFileFetch } from "./file-fetch.js";
import { useFiles } from "./node-host.test-support.js";

const { file } = useFiles("binary-fetch-", vi.restoreAllMocks);

async function fixture(bytes = Buffer.from("output")) {
  const target = await file("output.bin", bytes);
  const params = { path: target, transport: "binary", maxBytes: bytes.length };
  const preflight = await handleFileFetch({ ...params, preflightOnly: true });
  assert(preflight.ok, JSON.stringify(preflight));
  const controller = new AbortController();
  const ready = createDeferred<void>();
  let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const chunks: Buffer[] = [];
  const onChunk = vi.fn(async () => {});
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: {
      onMessage: (listener) => {
        receive = listener;
        ready.resolve();
        return () => {
          receive = undefined;
        };
      },
      send: async (message) => {
        expect(message.byteLength).toBeLessThanOrEqual(FILE_FETCH_CHUNK_BYTES);
        chunks.push(Buffer.from(message));
        await onChunk();
        await receive?.(Buffer.from("ack"));
      },
    },
  };
  const { binding: expectedBinding, path: expectedCanonicalPath } = preflight;
  const send = async (control: string) => {
    if (!receive) {
      throw new Error("No receiver");
    }
    await receive(Buffer.from(control));
  };
  const start = () => handleFileFetch({ ...params, expectedBinding, expectedCanonicalPath }, io);
  return { target, bytes, preflight, controller, ready, io, chunks, onChunk, send, start };
}

it("preflights without a stream and sends bounded chunks from the authorized handle after START", async () => {
  const value = await fixture(Buffer.alloc(17 * 1024 * 1024, 0x5a));
  expect(value.preflight).toMatchObject({ preflightOnly: true, base64: "", sha256: "" });
  const pending = value.start();
  await value.ready.promise;
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
  const value = await fixture();
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
  const value = await fixture(Buffer.alloc(FILE_FETCH_CHUNK_BYTES));
  const realOpen = fs.open.bind(fs);
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    closes.push(vi.spyOn(handle, "close"));
    return handle;
  });
  value.onChunk.mockImplementationOnce(() => fs.appendFile(value.target, "x"));
  const pending = value.start();
  await value.ready.promise;
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
