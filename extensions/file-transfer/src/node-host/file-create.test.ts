import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_CREATE_CHUNK_BYTES } from "../shared/file-create-protocol.js";
import { handleFileCreate } from "./file-create.js";
import * as fileWrite from "./file-write-path.js";

let directory: string;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-create-")));
});
afterEach(async () => await fs.rm(directory, { recursive: true, force: true }));
const digest = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

function receiver(controller = new AbortController()) {
  let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let ready!: () => void;
  const subscribed = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const ack = vi.fn(async (message: Uint8Array) => {
    expect(Buffer.from(message).toString()).toBe("ack");
  });
  const onMessage = vi.fn((callback: NonNullable<typeof listener>) => {
    listener = callback;
    ready();
    return () => {
      listener = undefined;
    };
  });
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: { send: ack, onMessage },
  };
  return {
    controller,
    io,
    subscribed,
    ack,
    onMessage,
    send: async (bytes: Uint8Array) => {
      if (!listener) {
        throw new Error("receiver is not subscribed");
      }
      await listener(bytes);
    },
  };
}

async function authorized(filePath: string, data: Buffer, extras: Record<string, unknown> = {}) {
  const params = {
    path: filePath,
    sizeBytes: data.length,
    expectedSha256: digest(data),
    createParents: true,
    followSymlinks: false,
    ...extras,
  };
  const preflight = await handleFileCreate({ ...params, preflightOnly: true });
  if (!preflight.ok) {
    throw new Error(JSON.stringify(preflight));
  }
  return { ...params, expectedCanonicalPath: preflight.path, expectedBinding: preflight.binding };
}

async function upload(params: Record<string, unknown>, data: Buffer) {
  const peer = receiver();
  const outcome = handleFileCreate(params, peer.io);
  await Promise.race([
    peer.subscribed,
    outcome.then((result) => {
      throw new Error(`closed before ready: ${JSON.stringify(result)}`);
    }),
  ]);
  for (let offset = 0; offset < data.length; offset += FILE_CREATE_CHUNK_BYTES) {
    await peer.send(data.subarray(offset, offset + FILE_CREATE_CHUNK_BYTES));
  }
  await peer.send(Buffer.alloc(0));
  return { result: await outcome, peer };
}

describe("file.create duplex command", () => {
  it.each([17, 50])(
    "creates %i MiB with bounded chunks and preserves replay edits",
    async (mebibytes) => {
      const data = Buffer.alloc(mebibytes * 1024 * 1024, 0x6a);
      const target = path.join(directory, "inputs", "large.bin");
      const created = await upload(await authorized(target, data), data);
      expect(created.result).toMatchObject({
        ok: true,
        status: "created",
        path: target,
        size: data.length,
        sha256: digest(data),
      });
      expect(created.peer.ack).toHaveBeenCalledTimes(mebibytes);
      expect(digest(await fs.readFile(target))).toBe(digest(data));
      await fs.writeFile(target, "user edit");
      const replay = await upload(await authorized(target, data), data);
      expect(replay.result).toMatchObject({ ok: true, status: "exists", path: target });
      expect(replay.result).not.toHaveProperty("sha256");
      expect(await fs.readFile(target, "utf8")).toBe("user edit");
    },
  );

  it("creates empty files without a data chunk", async () => {
    const data = Buffer.alloc(0);
    const target = path.join(directory, "empty");
    const { result, peer } = await upload(await authorized(target, data, { maxBytes: 0 }), data);
    expect(result).toMatchObject({ ok: true, status: "created", size: 0 });
    expect(peer.ack).not.toHaveBeenCalled();
    expect((await fs.stat(target)).size).toBe(0);
  });

  it("does not subscribe or create parents during preflight", async () => {
    const peer = receiver();
    const target = path.join(directory, "missing", "file");
    const result = await handleFileCreate(
      {
        path: target,
        sizeBytes: 1,
        expectedSha256: digest(Buffer.from("x")),
        createParents: true,
        preflightOnly: true,
      },
      peer.io,
    );
    expect(result).toMatchObject({ ok: true, binding: { kind: "write" } });
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("rejects a replaced canonical parent before subscribing", async () => {
    const parent = path.join(directory, "parent");
    await fs.mkdir(parent);
    const target = path.join(parent, "file");
    const params = await authorized(target, Buffer.from("x"));
    await fs.rename(parent, `${parent}-old`);
    await fs.mkdir(parent);
    const peer = receiver();
    expect(await handleFileCreate(params, peer.io)).toMatchObject({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
    });
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("rejects a parent replaced while bytes are being received", async () => {
    const parent = path.join(directory, "parent");
    await fs.mkdir(parent);
    const target = path.join(parent, "file");
    const data = Buffer.from("data");
    const params = await authorized(target, data);
    const peer = receiver();
    const outcome = handleFileCreate(params, peer.io);
    const settled = outcome.catch((error: unknown) => error);
    await peer.subscribed;
    await peer.send(data);
    await fs.rename(parent, `${parent}-old`);
    await fs.mkdir(parent);
    await peer.send(Buffer.alloc(0));
    const result = await settled;
    expect(result).not.toMatchObject({ ok: true });
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readdir(`${parent}-old`)).toEqual([]);
  });

  it.each(["root", "leaf"])("rejects an existing %s symlink before subscribing", async (kind) => {
    const actual = path.join(directory, "actual");
    await fs.mkdir(actual);
    await fs.writeFile(path.join(actual, "file"), "untouched");
    const alias = path.join(directory, "alias");
    await fs.symlink(kind === "root" ? actual : path.join(actual, "file"), alias);
    const target = kind === "root" ? path.join(alias, "new") : alias;
    const peer = receiver();
    const result = await handleFileCreate(
      {
        path: target,
        sizeBytes: 1,
        expectedSha256: digest(Buffer.from("x")),
        preflightOnly: true,
        followSymlinks: false,
      },
      peer.io,
    );
    expect(result.ok).toBe(false);
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(actual, "file"), "utf8")).toBe("untouched");
  });

  it("never accepts a symlink leaf as an existing file even when parents may follow aliases", async () => {
    const target = path.join(directory, "target");
    const alias = path.join(directory, "alias");
    await fs.writeFile(target, "original");
    await fs.symlink(target, alias);
    const peer = receiver();
    const result = await handleFileCreate(
      {
        path: alias,
        sizeBytes: 1,
        expectedSha256: digest(Buffer.from("x")),
        followSymlinks: true,
        preflightOnly: true,
      },
      peer.io,
    );
    expect(result.ok).toBe(false);
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it.each(["cancel", "digest", "size", "chunk"])(
    "leaves no published file after %s failure",
    async (failure) => {
      const target = path.join(directory, "file");
      const data = Buffer.from("data");
      const peer = receiver();
      const params = await authorized(target, data);
      const outcome = handleFileCreate(params, peer.io);
      const rejected = expect(outcome).rejects.toThrow();
      await peer.subscribed;
      if (failure === "cancel") {
        await peer.send(data.subarray(0, 1));
        peer.controller.abort(new Error("source revoked"));
      } else if (failure === "chunk") {
        await peer.send(Buffer.alloc(FILE_CREATE_CHUNK_BYTES + 1));
      } else {
        await peer.send(failure === "size" ? data.subarray(0, 1) : Buffer.from("nope"));
        await peer.send(Buffer.alloc(0));
      }
      await rejected;
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it("accepts the next chunk delivered before the prior ACK send promise settles", async () => {
    const data = Buffer.from("ab");
    const target = path.join(directory, "ack-race");
    const peer = receiver();
    const outcome = handleFileCreate(await authorized(target, data), peer.io);
    await peer.subscribed;
    peer.ack.mockImplementationOnce(async () => {
      await peer.send(data.subarray(1));
    });
    await peer.send(data.subarray(0, 1));
    await peer.send(Buffer.alloc(0));
    expect(await outcome).toMatchObject({ ok: true, status: "created" });
    expect(await fs.readFile(target)).toEqual(data);
  });

  it("cleans an unpublished fs-safe stage when cancelled during file writing", async () => {
    const data = Buffer.alloc(2 * FILE_CREATE_CHUNK_BYTES, 0x42);
    const target = path.join(directory, "cancel-publication");
    const peer = receiver();
    const original = fileWrite.openBoundWriteRoot;
    const spy = vi.spyOn(fileWrite, "openBoundWriteRoot").mockImplementationOnce(async (input) => {
      const result = await original(input);
      if (result.ok) {
        const create = result.anchorRoot.create.bind(result.anchorRoot);
        vi.spyOn(result.anchorRoot, "create").mockImplementation(
          async (relativePath, chunks, options) => {
            await create(
              relativePath,
              (async function* () {
                for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
                  yield chunk;
                  peer.controller.abort(new Error("cancel publication"));
                }
              })(),
              options,
            );
          },
        );
      }
      return result;
    });
    try {
      const outcome = handleFileCreate(await authorized(target, data), peer.io);
      const rejected = expect(outcome).rejects.toThrow("cancel publication");
      await peer.subscribed;
      await peer.send(data.subarray(0, FILE_CREATE_CHUNK_BYTES));
      await peer.send(data.subarray(FILE_CREATE_CHUNK_BYTES));
      await peer.send(Buffer.alloc(0));
      await rejected;
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing binding and oversized metadata without subscribing", async () => {
    const peer = receiver();
    const target = path.join(directory, "file");
    const params = { path: target, sizeBytes: 1, expectedSha256: digest(Buffer.from("x")) };
    expect(await handleFileCreate(params, peer.io)).toMatchObject({
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
    });
    expect(await handleFileCreate({ ...params, maxBytes: 0 }, peer.io)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(peer.onMessage).not.toHaveBeenCalled();
  });
});
