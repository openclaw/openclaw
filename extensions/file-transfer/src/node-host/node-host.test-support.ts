import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import { afterEach, beforeEach, vi } from "vitest";

export function duplexPeer() {
  let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const ready = Promise.withResolvers<void>();
  const controller = new AbortController();
  const send = vi.fn(async (_message: Uint8Array) => {});
  const onMessage = vi.fn((callback: NonNullable<typeof listener>) => {
    listener = callback;
    ready.resolve();
    return () => {
      listener = undefined;
    };
  });
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: controller.signal,
    emitChunk: async () => {},
    onInput: () => {},
    frames: { send, onMessage },
  };
  return {
    controller,
    io,
    send,
    onMessage,
    ready: ready.promise,
    receive: async (bytes: Uint8Array) => {
      if (!listener) {
        throw new Error("No receiver");
      }
      await listener(bytes);
    },
  };
}

export function useFiles(prefix: string, cleanup?: () => void) {
  let root: string;
  beforeEach(async () => {
    // Canonicalize macOS temp aliases so only explicit fixture links redirect.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  });
  afterEach(async () => {
    cleanup?.();
    await fs.rm(root, { recursive: true, force: true });
  });
  const at = (...parts: string[]) => path.join(root, ...parts);
  const dir = async (name: string) => {
    const target = at(name);
    await fs.mkdir(target, { recursive: true });
    return target;
  };
  const file = async (name: string, content: string | Buffer = "x") => {
    const target = at(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return target;
  };
  const seed = async (names: string[], content: string | Buffer = "x") => {
    for (const name of names) {
      await file(name, content);
    }
  };
  return { at, dir, file, seed };
}
