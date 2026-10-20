import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { describe, expect, it, vi } from "vitest";
import { FILE_CREATE_CHUNK_BYTES } from "../shared/file-create-protocol.js";
import { handleFileCreate } from "./file-create.js";
import * as fileWrite from "./file-write-path.js";
import { useFiles } from "./node-host.test-support.js";

const { at, dir: makeDir } = useFiles("file-create-test-");
const digest = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const metadata = (target: string, data: Buffer = Buffer.from("x")) => ({
  path: target,
  sizeBytes: data.length,
  expectedSha256: digest(data),
});

function receiver(controller = new AbortController()) {
  let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const subscribed = createDeferred<void>();
  const ack = vi.fn(async (message: Uint8Array) => {
    expect(Buffer.from(message).toString()).toBe("ack");
  });
  const onMessage = vi.fn((callback: NonNullable<typeof listener>) => {
    listener = callback;
    subscribed.resolve();
    return () => {
      listener = undefined;
    };
  });
  return {
    controller,
    io: {
      signal: controller.signal,
      emitChunk: async () => {},
      onInput: () => {},
      frames: { send: ack, onMessage },
    } satisfies OpenClawPluginNodeHostCommandIo,
    subscribed: subscribed.promise,
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

async function authorized(filePath: string, data: Buffer) {
  const params = {
    ...metadata(filePath, data),
    createParents: true,
    followSymlinks: false,
  };
  const peer = receiver();
  const preflight = await handleFileCreate({ ...params, preflightOnly: true }, peer.io);
  expect(preflight).toMatchObject({ ok: true, binding: { kind: "write" } });
  expect(peer.onMessage).not.toHaveBeenCalled();
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
  let offset = 0;
  const sendNext = async () => {
    const chunk = data.subarray(offset, offset + FILE_CREATE_CHUNK_BYTES);
    offset += chunk.length;
    await peer.send(chunk);
  };
  // The next chunk may arrive before the previous ACK send settles.
  peer.ack.mockImplementationOnce(async (message) => {
    expect(Buffer.from(message).toString()).toBe("ack");
    await sendNext();
  });
  while (offset < data.length) {
    await sendNext();
  }
  await peer.send(Buffer.alloc(0));
  return { result: await outcome, peer };
}

describe("file.create duplex command", () => {
  it("creates 50 MiB with bounded chunks and preserves replay edits", async () => {
    const data = Buffer.alloc(50 * 1024 * 1024, 0x6a);
    const target = at("inputs", "large.bin");
    const params = await authorized(target, data);
    expect(await fs.readdir(at())).toEqual([]);
    const created = await upload(params, data);
    expect(created.result).toMatchObject({
      ok: true,
      status: "created",
      path: target,
      size: data.length,
      sha256: digest(data),
    });
    expect(created.peer.ack).toHaveBeenCalledTimes(50);
    expect(digest(await fs.readFile(target))).toBe(digest(data));
    await fs.writeFile(target, "user edit");
    const replay = await upload(await authorized(target, data), data);
    expect(replay.result).toMatchObject({ ok: true, status: "exists", path: target });
    expect(replay.result).not.toHaveProperty("sha256");
    expect(await fs.readFile(target, "utf8")).toBe("user edit");
  });

  it.each([false, true])("rejects parent replacement duringReceive=%s", async (duringReceive) => {
    const parent = await makeDir("parent");
    const target = path.join(parent, "file");
    const data = Buffer.from("data");
    const params = await authorized(target, data);
    const peer = receiver();
    const receiving = duringReceive
      ? handleFileCreate(params, peer.io).catch((error: unknown) => error)
      : undefined;
    if (duringReceive) {
      await peer.subscribed;
      await peer.send(data);
    }
    await fs.rename(parent, `${parent}-old`);
    await fs.mkdir(parent);
    if (duringReceive) {
      await peer.send(Buffer.alloc(0));
    }
    const result = await (receiving ?? handleFileCreate(params, peer.io));
    expect(result).not.toMatchObject({ ok: true });
    if (!duringReceive) {
      expect(result).toMatchObject({ ok: false, code: "CANONICAL_PATH_CHANGED" });
      expect(peer.onMessage).not.toHaveBeenCalled();
    }
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readdir(`${parent}-old`)).toEqual([]);
  });

  it.each([
    { kind: "root", followSymlinks: false },
    { kind: "leaf", followSymlinks: false },
    { kind: "leaf", followSymlinks: true },
  ])(
    "rejects a $kind symlink with followSymlinks=$followSymlinks before subscribing",
    async ({ kind, followSymlinks }) => {
      const actual = await makeDir("actual");
      await fs.writeFile(path.join(actual, "file"), "untouched");
      const alias = at("alias");
      await fs.symlink(kind === "root" ? actual : path.join(actual, "file"), alias);
      const target = kind === "root" ? path.join(alias, "new") : alias;
      const peer = receiver();
      const params = { ...metadata(target), preflightOnly: true, followSymlinks };
      const result = await handleFileCreate(params, peer.io);
      expect(result.ok).toBe(false);
      expect(peer.onMessage).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(actual, "file"), "utf8")).toBe("untouched");
    },
  );

  it.each(["cancel", "digest", "size", "chunk"])(
    "leaves no published file after %s failure",
    async (failure) => {
      const target = at("file");
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
      expect(await fs.readdir(at())).toEqual([]);
    },
  );

  it("cleans an unpublished fs-safe stage when cancelled during file writing", async () => {
    const data = Buffer.alloc(2 * FILE_CREATE_CHUNK_BYTES, 0x42);
    const target = at("cancel-publication");
    const peer = receiver();
    const original = fileWrite.openBoundWriteRoot;
    const spy = vi.spyOn(fileWrite, "openBoundWriteRoot").mockImplementationOnce(async (input) => {
      const result = await original(input);
      if (result.ok) {
        const create = result.anchorRoot.create.bind(result.anchorRoot);
        vi.spyOn(result.anchorRoot, "create").mockImplementation(
          async (relativePath, chunks, options) => {
            async function* abortAfterChunk() {
              for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
                yield chunk;
                peer.controller.abort(new Error("cancel publication"));
              }
            }
            await create(relativePath, abortAfterChunk(), options);
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
      expect(await fs.readdir(at())).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects missing binding and oversized metadata without subscribing", async () => {
    const peer = receiver();
    const params = metadata(at("file"));
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
