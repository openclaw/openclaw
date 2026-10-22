import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";

export async function listenLoopback(server: Server): Promise<string> {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "expected loopback server address");
  return `http://127.0.0.1:${address.port}`;
}

export async function closeServer(server?: Server): Promise<void> {
  if (!server?.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
