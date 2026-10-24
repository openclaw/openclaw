import net from "node:net";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

type IrcTestServer = {
  port: number;
  openSocketCount(): number;
  close(): Promise<void>;
};

export async function startIrcTestServer(
  onConnection: (socket: net.Socket) => void,
): Promise<IrcTestServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  const port = await listenOnLoopback(server);
  return {
    port,
    openSocketCount: () => sockets.size,
    close: async () => {
      // Server.close waits for accepted peers; destroy them before awaiting listener shutdown.
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function onIrcTestLine(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      onLine(line);
    }
  });
}
