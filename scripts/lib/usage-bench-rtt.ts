import { createConnection, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

// Proof-only byte relay: no HTTP/WebSocket interpretation or response substitution.
export async function startUsageRttProxy(
  targetPort: number,
  oneWayMs = 50,
): Promise<{ port: number; close: () => Promise<void> }> {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error("targetPort must be an integer between 1 and 65535");
  }
  if (!Number.isFinite(oneWayMs) || oneWayMs < 0 || oneWayMs > 2_147_483_647) {
    throw new Error("oneWayMs must be a finite nonnegative timer delay");
  }

  const maxQueuedBytes = 256 * 1024;
  const connections = new Set<{ stop: () => void; closed: Promise<void> }>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function relay(source: Socket, destination: Socket): () => void {
    const queue: Array<{ bytes: Buffer; due: number }> = [];
    let queuedBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let blocked = false;
    let ended = false;
    let stopped = false;

    function pump() {
      if (stopped) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      if (destination.connecting || blocked) {
        source.pause();
        return;
      }
      while (queue.length > 0) {
        const next = queue[0]!;
        const remaining = next.due - performance.now();
        if (remaining > 0) {
          timer = setTimeout(pump, Math.ceil(remaining));
          break;
        }
        queue.shift();
        queuedBytes -= next.bytes.length;
        if (!destination.write(next.bytes)) {
          blocked = true;
          source.pause();
          return;
        }
      }
      if (queuedBytes < maxQueuedBytes) {
        source.resume();
      }
      // Preserve half-closes: forward FIN only after its preceding bytes.
      if (ended && queue.length === 0 && !destination.writableEnded) {
        destination.end();
      }
    }

    function onData(bytes: Buffer) {
      // Each chunk has its own arrival deadline; delay never accumulates per chunk.
      queue.push({ bytes, due: performance.now() + oneWayMs });
      queuedBytes += bytes.length;
      if (queuedBytes >= maxQueuedBytes) {
        source.pause();
      }
      pump();
    }
    function onEnd() {
      ended = true;
      pump();
    }
    function onDrain() {
      blocked = false;
      pump();
    }

    source.on("data", onData);
    source.on("end", onEnd);
    destination.on("drain", onDrain);
    destination.on("connect", pump);
    if (destination.connecting) {
      source.pause();
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      queue.length = 0;
      queuedBytes = 0;
      source.off("data", onData);
      source.off("end", onEnd);
      destination.off("drain", onDrain);
      destination.off("connect", pump);
    };
  }

  const server = createServer({ allowHalfOpen: true }, (client) => {
    const upstream = createConnection({
      host: "127.0.0.1",
      port: targetPort,
      allowHalfOpen: true,
    });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const stopFlows: Array<() => void> = [];
    let stopped = false;
    let openSockets = 2;
    let resolveClosed!: () => void;
    const connection = {
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
      stop(this: void) {
        if (stopped) {
          return;
        }
        stopped = true;
        stopFlows.forEach((stop) => stop());
        client.destroy();
        upstream.destroy();
      },
    };
    connections.add(connection);
    for (const socket of [client, upstream]) {
      socket.on("error", connection.stop);
      socket.once("close", () => {
        if (!socket.readableEnded) {
          connection.stop();
        }
        if (--openSockets === 0) {
          stopFlows.forEach((stop) => stop());
          connections.delete(connection);
          resolveClosed();
        }
      });
    }
    stopFlows.push(relay(client, upstream), relay(upstream, client));
    if (closing) {
      connection.stop();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback relay did not receive a TCP port");
  }
  return {
    port: address.port,
    close() {
      closePromise ??= (async () => {
        closing = true;
        const listenerClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        const active = [...connections];
        active.forEach((connection) => connection.stop());
        await Promise.all([listenerClosed, ...active.map((connection) => connection.closed)]);
      })();
      return closePromise;
    },
  };
}
