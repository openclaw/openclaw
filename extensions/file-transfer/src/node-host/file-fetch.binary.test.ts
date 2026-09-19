import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_FETCH_CHUNK_BYTES } from "../shared/file-fetch-protocol.js";
import { handleFileFetch } from "./file-fetch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes = Buffer.from("output"), maxBytes = bytes.length) {
  const directory = await fs.realpath(tempDirs.make("binary-fetch-"));
  const target = path.join(directory, "output.bin");
  await fs.writeFile(target, bytes);
  const params = { path: target, transport: "binary", maxBytes };
  const preflight = await handleFileFetch({ ...params, preflightOnly: true });
  if (!preflight.ok) {
    throw new Error(preflight.message);
  }
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
  return {
    target,
    bytes,
    params,
    preflight,
    controller,
    ready,
    io,
    chunks,
    onChunk,
    send: async (control: string) => {
      if (!receive) {
        throw new Error("No receiver");
      }
      await receive(Buffer.from(control));
    },
    start: () =>
      handleFileFetch(
        {
          ...params,
          expectedBinding: preflight.binding,
          expectedCanonicalPath: preflight.path,
        },
        io,
      ),
  };
}

describe("binary file.fetch", () => {
  it("preflights without a stream and waits for START before sending bounded chunks", async () => {
    const value = await fixture(Buffer.alloc(17 * 1024 * 1024, 0x5a));
    expect(value.preflight).toMatchObject({ preflightOnly: true, base64: "", sha256: "" });
    const pending = value.start();
    await value.ready.promise;
    expect(value.chunks).toHaveLength(0);
    await value.send("start");
    const result = await pending;
    expect(result).toMatchObject({
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

  it("rejects replacement after preflight before opening a stream", async () => {
    const value = await fixture();
    await fs.rename(value.target, `${value.target}.old`);
    await fs.writeFile(value.target, "other");
    expect(await value.start()).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
    expect(value.chunks).toHaveLength(0);
    await expect(value.send("start")).rejects.toThrow("No receiver");
  });

  it("retains the opened file when the pathname is replaced after readiness", async () => {
    const value = await fixture();
    const pending = value.start();
    await value.ready.promise;
    await fs.rename(value.target, `${value.target}.old`);
    await fs.writeFile(value.target, "other");
    await value.send("start");
    expect(await pending).toMatchObject({ ok: true, size: value.bytes.length });
    expect(Buffer.concat(value.chunks)).toEqual(value.bytes);
  });

  it("rejects growth beyond the budget without sending excess bytes", async () => {
    const value = await fixture(Buffer.alloc(FILE_FETCH_CHUNK_BYTES));
    value.onChunk.mockImplementationOnce(async () => {
      await fs.appendFile(value.target, "x");
    });
    const pending = value.start();
    await value.ready.promise;
    await value.send("start");
    expect(await pending).toMatchObject({ ok: false, code: "FILE_TOO_LARGE" });
    expect(Buffer.concat(value.chunks).length).toBe(FILE_FETCH_CHUNK_BYTES);
  });

  it("closes the owned handle and listener on cancellation before START", async () => {
    const value = await fixture();
    const realOpen = fs.open.bind(fs);
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      closes.push(vi.spyOn(handle, "close"));
      return handle;
    });
    const pending = value.start();
    await value.ready.promise;
    value.controller.abort(new Error("revoked"));
    expect(await pending).toMatchObject({ ok: false, code: "READ_ERROR" });
    expect(closes.length).toBeGreaterThan(0);
    for (const close of closes) {
      expect(close).toHaveBeenCalledOnce();
    }
    await expect(value.send("start")).rejects.toThrow("No receiver");
    expect(value.chunks).toHaveLength(0);
  });

  it.each([undefined, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid explicit binary budget %s",
    async (maxBytes) => {
      const value = await fixture();
      expect(await handleFileFetch({ ...value.params, maxBytes })).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
    },
  );
});
