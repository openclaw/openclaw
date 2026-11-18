// Synthetic Gateway entry for attributing main-thread synchronous fsync calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

assert.ok(process.env.OPENCLAW_STATE_DIR, "An isolated team-shape fixture is required");
assert.ok(
  fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "team-shape-summary.json")),
  "Run only against generated team-shape fixtures",
);
if (isMainThread) {
  Error.stackTraceLimit = 40;
  const mediaIo = process.env.OPENCLAW_PERF_MEDIA_IO === "1";
  const syncDelayMs = Number(process.env.OPENCLAW_PERF_FSYNC_DELAY_MS ?? 0);
  assert.ok(Number.isFinite(syncDelayMs) && syncDelayMs >= 0 && syncDelayMs <= 1000);
  const instrumentMedia = mediaIo || syncDelayMs > 0;
  const inboundDirs = new Set(
    [
      path.resolve(process.env.OPENCLAW_STATE_DIR),
      fs.realpathSync(process.env.OPENCLAW_STATE_DIR),
    ].map((root) => path.join(root, "media/inbound")),
  );
  const descriptorPaths = new Map<number, string>();
  const sleepWord = new Int32Array(new SharedArrayBuffer(4));
  const inboundPath = (value: unknown): string | undefined => {
    const filename =
      typeof value === "string"
        ? value
        : value instanceof URL
          ? fileURLToPath(value)
          : Buffer.isBuffer(value)
            ? value.toString()
            : undefined;
    if (!filename) {
      return undefined;
    }
    const resolved = path.resolve(filename);
    for (const inboundDir of inboundDirs) {
      if (resolved === inboundDir || resolved.startsWith(`${inboundDir}${path.sep}`)) {
        return path.relative(inboundDir, resolved) || ".";
      }
    }
    return undefined;
  };
  const descriptorPath = (fd: number): string | undefined => {
    const recorded = descriptorPaths.get(fd);
    if (recorded !== undefined || process.platform !== "linux") {
      return recorded;
    }
    // Native fs-safe opens do not pass through the JavaScript open wrappers.
    try {
      return inboundPath(fs.readlinkSync(`/proc/self/fd/${fd}`));
    } catch {
      return undefined;
    }
  };
  const recordMediaIo = (
    operation: string,
    filename: string,
    started: number,
    stack: string | undefined,
    injectedDelayMs = 0,
  ) => {
    if (mediaIo) {
      process.stderr.write(
        `MEDIA_IO_PROBE ${JSON.stringify({ at: Date.now(), operation, path: filename, ms: performance.now() - started, blocking: false, injectedDelayMs, stack })}\n`,
      );
    }
  };
  function traceAsync<T extends (...args: never[]) => Promise<unknown>>(
    operation: string,
    original: T,
    filename?: string,
  ): T {
    return new Proxy(original, {
      async apply(target, receiver, args) {
        const selected = filename ?? inboundPath(args[0]);
        if (selected === undefined) {
          return await Reflect.apply(target, receiver, args);
        }
        const stack = mediaIo ? new Error(`media-${operation}`).stack : undefined;
        const started = performance.now();
        const injected = operation === "sync" ? syncDelayMs : 0;
        try {
          if (injected > 0) {
            await delay(injected);
          }
          return await Reflect.apply(target, receiver, args);
        } finally {
          recordMediaIo(operation, selected, started, stack, injected);
        }
      },
    });
  }
  if (instrumentMedia) {
    const open = mediaIo ? traceAsync("open", fsPromises.open) : fsPromises.open;
    fsPromises.open = async (...args) => {
      const handle = await open(...args);
      const filename = inboundPath(args[0]);
      if (filename !== undefined) {
        descriptorPaths.set(handle.fd, filename);
        handle.sync = traceAsync("sync", handle.sync.bind(handle), filename);
        if (mediaIo) {
          handle.writeFile = traceAsync("writeFile", handle.writeFile.bind(handle), filename);
          handle.readFile = traceAsync("readFile", handle.readFile.bind(handle), filename);
          handle.chmod = traceAsync("chmod", handle.chmod.bind(handle), filename);
        }
        const close = mediaIo
          ? traceAsync("close", handle.close.bind(handle), filename)
          : handle.close.bind(handle);
        const fd = handle.fd;
        handle.close = async () => {
          await close();
          descriptorPaths.delete(fd);
        };
      }
      return handle;
    };
    if (mediaIo) {
      fsPromises.mkdir = traceAsync("mkdir", fsPromises.mkdir);
      fsPromises.lstat = traceAsync("lstat", fsPromises.lstat);
      fsPromises.stat = traceAsync("stat", fsPromises.stat);
      fsPromises.realpath = traceAsync("realpath", fsPromises.realpath);
      fsPromises.rename = traceAsync("rename", fsPromises.rename);
      fsPromises.unlink = traceAsync("unlink", fsPromises.unlink);
    }
    const openSync = fs.openSync;
    fs.openSync = (...args) => {
      const fd = openSync(...args);
      const filename = inboundPath(args[0]);
      if (filename !== undefined) {
        descriptorPaths.set(fd, filename);
      }
      return fd;
    };
    const closeSync = fs.closeSync;
    fs.closeSync = (fd) => {
      closeSync(fd);
      descriptorPaths.delete(fd);
    };
  }
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const stack = new Error("main-thread-fsync").stack;
    const filename = instrumentMedia ? descriptorPath(fd) : undefined;
    const injectedDelayMs = filename === undefined ? 0 : syncDelayMs;
    const started = performance.now();
    try {
      if (injectedDelayMs > 0) {
        Atomics.wait(sleepWord, 0, 0, injectedDelayMs);
      }
      return original(fd);
    } finally {
      process.stderr.write(
        `FSYNC_PROBE ${JSON.stringify({ at: Date.now(), ms: performance.now() - started, blocking: true, injectedDelayMs, path: filename, stack })}\n`,
      );
    }
  };
  syncBuiltinESMExports();
}
process.argv[1] = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
await import("../../src/entry.ts");
