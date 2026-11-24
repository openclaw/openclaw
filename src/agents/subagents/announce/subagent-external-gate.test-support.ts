import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { redactSensitiveText } from "../../../logging/redact.js";

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

export async function observeHeldExecutor(options: {
  isHeldAndLive: () => boolean;
  waitForRun: () => Promise<{
    status: string;
    endedAt?: number;
    error?: string;
    stopReason?: string;
    timeoutPhase?: string;
    providerStarted?: boolean;
  }>;
}): Promise<true | undefined> {
  if (options.isHeldAndLive()) {
    return true;
  }
  const outcome = await options.waitForRun();
  // A wait deadline is not a terminal run timeout; only the latter has an end time.
  if (outcome.endedAt !== undefined) {
    const details = [`status=${outcome.status}`];
    if (outcome.stopReason) {
      details.push(`stopReason=${outcome.stopReason}`);
    }
    if (outcome.timeoutPhase) {
      details.push(`timeoutPhase=${outcome.timeoutPhase}`);
    }
    if (outcome.providerStarted !== undefined) {
      details.push(`providerStarted=${outcome.providerStarted}`);
    }
    const reason = outcome.error ? `: ${outcome.error}` : "";
    throw new Error(
      redactSensitiveText(
        `Foreign child executor ended before reaching the held gate: ${details.join(", ")}${reason}`,
      ),
    );
  }
  return options.isHeldAndLive() ? true : undefined;
}
