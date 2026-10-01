// Qa Lab plugin module implements process wait helper behavior.
import fs from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const POLL_INTERVAL_MS = 10;
// Generous ceiling for loaded CI runners: callers synchronize on the asserted
// state, so a large bound only delays failure reporting, never success.
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

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

// A fixture must reach its gate before its owning operation settles; preserve early rejections.
export function awaitGateBeforeSettlement<T>(
  gate: PromiseLike<T>,
  operation: PromiseLike<unknown>,
  message: string,
): Promise<Awaited<T>> {
  return Promise.race([
    gate,
    Promise.resolve(operation).then((): never => {
      throw new Error(message);
    }),
  ]);
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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForFile(
  filePath: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`);
}

// writeFileSync exposes an open-truncate window to observers, so wait for a
// parseable pid, never bare existence; an existence wait reads "" into NaN.
export async function waitForPidFile(
  filePath: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<number> {
  const deadlineAt = Date.now() + timeoutMs;
  let lastContent: string | undefined;
  while (Date.now() < deadlineAt) {
    lastContent = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (lastContent !== undefined) {
      const pid = Number.parseInt(lastContent, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const lastState =
    lastContent === undefined
      ? "file missing"
      : `unparsable content ${JSON.stringify(lastContent)}`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for pid file ${filePath} (${lastState})`);
}

export async function waitForDead(pid: number, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for pid ${pid} to exit`);
}
