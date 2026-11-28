import { assert, vi } from "vitest";
import type { GatewayProtocolClientOptions } from "./protocol-client-contract.js";
import { GatewayProtocolClient, type GatewayProtocolSocketHandlers } from "./protocol-client.js";

type Options = GatewayProtocolClientOptions<Record<string, never>>;
export type Frame = { id: string; method: string };
export type Connection = ReturnType<typeof createProtocolHarness>["connections"][number];
const clients: GatewayProtocolClient<Record<string, never>>[] = [];

export function stopProtocolClients() {
  for (const client of clients.splice(0)) {
    client.stop();
  }
}

export function createProtocolClient(options: Partial<Options> & Pick<Options, "createSocket">) {
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createRequestId: () => `request-${++nextRequestId}`,
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: true, notify: true }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    ...options,
  });
  clients.push(client);
  return client;
}

export function createProtocolHarness(
  options: Partial<Options> = {},
  socketOptions: { delayClose?: boolean; send?: (frame: Frame) => void } = {},
) {
  const connections: Array<{
    handlers: GatewayProtocolSocketHandlers;
    send: ReturnType<typeof vi.fn<(data: string) => void>>;
    close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
    frames: Frame[];
  }> = [];
  const client = createProtocolClient({
    createSocket: (handlers) => {
      let open = true;
      const frames: Frame[] = [];
      const send = vi.fn<(data: string) => void>((data) => {
        const frame = JSON.parse(data) as Frame;
        frames.push(frame);
        socketOptions.send?.(frame);
      });
      const close = vi.fn<(code?: number, reason?: string) => void>((code, reason) => {
        open = false;
        if (!socketOptions.delayClose) {
          handlers.close(code ?? 1000, reason ?? "");
        }
      });
      connections.push({ handlers, send, close, frames });
      return { isOpen: () => open, send, close };
    },
    ...options,
  });
  return { client, connections };
}

export function receive(connection: { handlers: GatewayProtocolSocketHandlers }, frame: unknown) {
  connection.handlers.message(JSON.stringify(frame));
}

export function startProtocolHarness(
  options: Partial<Options> = {},
  socketOptions: Parameters<typeof createProtocolHarness>[1] = {},
) {
  const harness = createProtocolHarness(options, socketOptions);
  harness.client.start();
  const connection = harness.connections[0];
  assert(connection);
  return { ...harness, connection };
}

export function lastFrame(connection: Connection): Frame {
  const frame = connection.frames.at(-1);
  assert(frame);
  return frame;
}

export function respond(connection: Connection, id: string, payload: unknown, ok = true) {
  receive(connection, { type: "res", id, ok, ...(ok ? { payload } : { error: payload }) });
}

export function challenge(
  connection: Connection,
  payload: unknown = { nonce: "synthetic-nonce", ts: 1_800_000_000_000 },
) {
  connection.handlers.open();
  receive(connection, { type: "event", event: "connect.challenge", payload });
}
