import fs from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";

function copyExecutable(source: string, target: string): void {
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o700);
}

/** Builds a user-owned Node layout whose executable and relative libnode path are both trusted. */
export function createTrustedNodeFixture(directory: string): string {
  const runtimeRoot = path.join(directory, "node-runtime");
  const binDir = path.join(runtimeRoot, "bin");
  const target = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
  if (fs.existsSync(target)) {
    return fs.realpathSync(target);
  }
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  copyExecutable(process.execPath, target);

  const sourceLibDir = path.resolve(path.dirname(process.execPath), "..", "lib");
  if (fs.existsSync(sourceLibDir)) {
    const libDir = path.join(runtimeRoot, "lib");
    for (const name of fs.readdirSync(sourceLibDir).filter((entry) => /^libnode[.]/u.test(entry))) {
      fs.mkdirSync(libDir, { recursive: true, mode: 0o700 });
      copyExecutable(fs.realpathSync(path.join(sourceLibDir, name)), path.join(libDir, name));
    }
  }
  return fs.realpathSync(target);
}

// Keep fixture waits timer-free while allowing Vitest cancellation to reach finally cleanup.
export function withinTest<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<Awaited<T>> {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error("test aborted", { cause: reason }));
    };
  });
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

// Observe product-owned fixtures without borrowing their stdout or process lifetime.
export async function openFixtureReadyChannel() {
  const waiters = new Map<string, PromiseWithResolvers<void>>();
  const sockets = new Set<Socket>();
  const receipt = (recordPath: string) => {
    let pending = waiters.get(recordPath);
    if (!pending) {
      pending = Promise.withResolvers<void>();
      waiters.set(recordPath, pending);
    }
    return pending;
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let recordPath = "";
    socket.on("data", (chunk: string) => {
      recordPath += chunk;
    });
    socket.on("end", () => receipt(recordPath).resolve());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture readiness observer did not bind a TCP port");
  }
  return {
    port: address.port,
    waitFor: (recordPath: string) => receipt(recordPath).promise,
    async close() {
      for (const pending of waiters.values()) {
        pending.reject(new Error("fixture readiness observer closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function fixtureReadyClientSource(port: number): string {
  return `import { createConnection } from 'node:net';
function sendReady(recordPath) {
  const socket = createConnection(${port}, '127.0.0.1');
  socket.on('error', () => {});
  socket.unref();
  socket.end(recordPath);
}`;
}
