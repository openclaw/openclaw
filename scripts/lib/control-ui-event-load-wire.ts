import { WebSocket, WebSocketServer } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import type {
  ControlUiMockRequestHandler,
  MockGatewayRequest,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  createEventLoadProducer,
  type EventLoadOptions,
  type EventLoadRow,
} from "./control-ui-event-load-producer.ts";

/** A loopback event source: scheduling, fixture reconciliation and encoding stay off the page. */
export async function createEventLoadWire(rows: EventLoadRow[]) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Event-load socket did not bind");
  }
  const canonical = new Map(rows.map((row) => [row.key, row]));
  const handlers = new Map<string, ControlUiMockRequestHandler>();
  let producer: ReturnType<typeof createEventLoadProducer> | undefined;
  let socket: WebSocket | undefined;
  let generation = 1;
  let nextGeneration = 1;
  let sequence = 0;
  let frames = 0;
  let bytes = 0;
  let backgroundFrames = 0;
  let backgroundBytes = 0;
  server.on("connection", (client) => {
    socket = client;
    client.on("message", (raw) => {
      const command = (JSON.parse(rawDataToString(raw)) as { eventLoadCommand: string })
        .eventLoadCommand;
      if (command === "typing") {
        producer?.admitTypingTools();
      } else if (command === "scroll") {
        producer?.admitScrollTools();
      } else if (command === "settle") {
        producer?.settle();
        client.send(
          JSON.stringify({ eventLoadProgress: producer?.ready(), eventLoadSettled: true }),
        );
      } else if (command === "disconnect") {
        generation = 0;
        producer?.disconnect();
      } else if (command === "connect") {
        generation = ++nextGeneration;
      }
    });
  });
  const stats = () => ({
    ...producer?.ready(),
    offeredFrames: frames,
    offeredBytes: bytes,
    offeredBackgroundFrames: backgroundFrames,
    offeredBackgroundBytes: backgroundBytes,
  });
  return {
    url: `ws://localhost:${address.port}/event-load`,
    start(options: EventLoadOptions, requests: MockGatewayRequest[], initialSequence = 0) {
      sequence = initialSequence;
      producer = createEventLoadProducer(
        {
          requests,
          getSessionRow(key) {
            const row = canonical.get(key);
            if (!row) {
              throw new Error(`Unknown event-load session: ${key}`);
            }
            return row;
          },
          setSessionRow(row) {
            canonical.set(row.key, row);
          },
          setRequestHandler(method, handler) {
            handlers.set(method, handler);
          },
          generation: () => generation,
          emit(event, payload) {
            if (socket?.readyState !== WebSocket.OPEN || !generation) {
              return;
            }
            const raw = JSON.stringify({ type: "event", event, payload, seq: ++sequence });
            frames++;
            bytes += Buffer.byteLength(raw);
            const key = (payload as { sessionKey?: string }).sessionKey;
            if (key && key !== options.foreground) {
              backgroundFrames++;
              backgroundBytes += Buffer.byteLength(raw);
            }
            socket.send(raw);
          },
          progress(value) {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ eventLoadProgress: value }));
            }
          },
        },
        options,
      );
    },
    startBackground() {
      producer!.startBackground();
    },
    request(method: string, params: unknown) {
      const handler = handlers.get(method);
      if (!handler) {
        throw new Error(`Event-load handler not ready: ${method}`);
      }
      return new Promise<unknown>((resolve) => {
        handler({ params, respond: resolve, emit() {} });
      });
    },
    currentRows: () => producer?.currentRows() ?? rows,
    finish() {
      producer?.finish();
      return stats();
    },
    stats,
    async close() {
      producer?.finish();
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
