import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";

export async function createExternalGates() {
  type Gate = {
    requests: number;
    pending: Set<ServerResponse>;
    result?: { code: number; body: string };
  };
  const gates = new Map<string, Gate>();
  const server = createServer((request, response) => {
    const gate = gates.get(request.url ?? "");
    if (request.method !== "GET" || !gate) {
      response.writeHead(404).end();
      return;
    }
    gate.requests += 1;
    if (gate.result) {
      response.writeHead(gate.result.code).end(gate.result.body);
      return;
    }
    gate.pending.add(response);
    response.on("close", () => gate.pending.delete(response));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("external gate did not receive a TCP port");
  }
  return {
    snapshot: () =>
      [...gates.values()].map((gate) => ({
        requests: gate.requests,
        waiting: gate.pending.size,
        released: Boolean(gate.result),
        responseCode: gate.result?.code,
      })),
    create() {
      const route = `/${randomUUID()}`;
      const gate: Gate = { requests: 0, pending: new Set() };
      gates.set(route, gate);
      return {
        url: `http://127.0.0.1:${address.port}${route}`,
        snapshot: () => ({
          requests: gate.requests,
          waiting: gate.pending.size,
          released: Boolean(gate.result),
        }),
        release(body: string, code = 200) {
          if (gate.result) {
            throw new Error("external gate was already released");
          }
          gate.result = { code, body };
          for (const response of gate.pending) {
            response.writeHead(code).end(body);
          }
        },
      };
    },
    async close() {
      for (const gate of gates.values()) {
        for (const response of gate.pending) {
          response.writeHead(503).end("fixture shutting down");
        }
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
