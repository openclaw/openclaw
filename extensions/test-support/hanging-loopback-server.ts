import { createServer } from "node:http";
import type { Socket } from "node:net";

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startHangingLoopbackServer(): Promise<{
  origin: string;
  requests: string[];
  waitForRequestCount: (count: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  type RequestWaiter = {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const waiters: RequestWaiter[] = [];

  const resolveWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || requests.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
    }
  };

  // Accept the request and deliberately never respond, so the guarded fetch
  // stays pending until the deadline aborts it.
  const server = createServer((req, _res) => {
    requests.push(req.url ?? "");
    req.resume();
    resolveWaiters();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    waitForRequestCount: async (count: number) => {
      if (requests.length >= count) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: RequestWaiter = { count, resolve, reject };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`server received ${requests.length} request(s), expected ${count}`));
        }, 2_000);
        waiters.push(waiter);
      });
    },
    close: async () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.reject(new Error("server closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
