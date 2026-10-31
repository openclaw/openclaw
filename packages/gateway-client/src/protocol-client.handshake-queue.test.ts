import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayProtocolSocketHandlers } from "./protocol-client.js";
import {
  createProtocolClient,
  lastFrame,
  startProtocolHarness,
  receive,
  respond,
  challenge as receiveConnectChallenge,
  stopProtocolClients,
  type Connection,
} from "./protocol-client.test-support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopProtocolClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function receiveHello(connection: Connection): void {
  const frame = connection.frames[0];
  assert(frame);
  respond(connection, frame.id, { type: "hello-ok" });
}

it("queues opening and signing requests until hello publishes, with connect first", async () => {
  const plan = createDeferred<Record<string, never>>();
  let open = false;
  let handlers: GatewayProtocolSocketHandlers | undefined;
  const send = vi.fn<(data: string) => void>();
  const delivery: string[] = [];
  let fromHello: Promise<unknown> | undefined;
  let fromSent: Promise<unknown> | undefined;
  const client = createProtocolClient({
    createSocket: (nextHandlers) => {
      handlers = nextHandlers;
      return { isOpen: () => open, send, close: vi.fn() };
    },
    buildConnectPlan: () => plan.promise,
    onHello: () => {
      delivery.push("hello");
      fromHello = client
        .request("third", {}, { onSent: () => delivery.push("third") })
        .catch((error: unknown) => error);
    },
  });
  client.start();
  const first = client
    .request(
      "first",
      {},
      {
        onSent: () => {
          delivery.push("first");
          fromSent = client
            .request("fourth", {}, { onSent: () => delivery.push("fourth") })
            .catch((error: unknown) => error);
        },
      },
    )
    .catch((error: unknown) => error);
  expect(send).not.toHaveBeenCalled();
  assert(handlers);
  const connection = { handlers };
  open = true;
  handlers.open();
  receive(connection, { type: "event", event: "connect.challenge", payload: { nonce: "test" } });
  const second = client
    .request("second", {}, { onSent: () => delivery.push("second") })
    .catch((error: unknown) => error);
  expect(send).not.toHaveBeenCalled();
  plan.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  const frames = () =>
    send.mock.calls.map(([data]) => JSON.parse(data) as { id: string; method: string });
  expect(frames().map((frame) => frame.method)).toEqual(["connect"]);
  const connect = frames()[0];
  assert(connect);
  receive(connection, {
    type: "res",
    id: connect.id,
    ok: true,
    payload: { type: "hello-ok" },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(delivery).toEqual(["hello", "first", "second", "third", "fourth"]);
  expect(frames().map((frame) => frame.method)).toEqual([
    "connect",
    "first",
    "second",
    "third",
    "fourth",
  ]);
  for (const frame of frames().slice(1)) {
    receive(connection, { type: "res", id: frame.id, ok: true, payload: frame.method });
  }
  await expect(Promise.all([first, second, fromHello, fromSent])).resolves.toEqual([
    "first",
    "second",
    "third",
    "fourth",
  ]);
  expect(client.hasPendingRequests).toBe(false);
});
it("stops releasing held requests when an earlier onSent closes before its close event", async () => {
  const { client, connection } = startProtocolHarness(
    { resolveClose: () => ({ retry: false, notify: false }) },
    { delayClose: true },
  );
  const first = client
    .request("first", {}, { onSent: () => client.closeSocket(4000, "retired by sent callback") })
    .catch((error: unknown) => error);
  const onSent = vi.fn();
  const second = client.request("second", {}, { onSent }).catch((error: unknown) => error);
  receiveConnectChallenge(connection);
  receiveHello(connection);
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.frames.map((frame) => frame.method)).toEqual(["connect", "first"]);
  expect(onSent).not.toHaveBeenCalled();
  connection.handlers.close(4000, "retired by sent callback");
  for (const outcome of await Promise.all([first, second])) {
    expect(outcome).toHaveProperty("message", "gateway closed (4000): retired by sent callback");
  }
  expect(client.hasPendingRequests).toBe(false);
});
it.each(["abort", "timeout"])("retires an unsent pre-hello request on %s", async (retirement) => {
  const { client, connection } = startProtocolHarness();
  const controller = new AbortController();
  const onSent = vi.fn();
  const outcome = client
    .request(
      "sessions.create",
      {},
      {
        signal: controller.signal,
        timeoutMs: 5,
        retainSentResultOnAbort: true,
        onSent,
      },
    )
    .catch((error: unknown) => error);
  receiveConnectChallenge(connection);
  expect(onSent).not.toHaveBeenCalled();
  if (retirement === "abort") {
    controller.abort();
    await expect(outcome).resolves.toHaveProperty(
      "message",
      "gateway request aborted for sessions.create",
    );
  } else {
    await vi.advanceTimersByTimeAsync(5);
    await expect(outcome).resolves.toMatchObject({ code: "CLIENT_TIMEOUT", requestSent: false });
  }
  receiveHello(connection);
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.frames.map((frame) => frame.method)).toEqual(["connect"]);
  expect(onSent).not.toHaveBeenCalled();
  expect(client.hasPendingRequests).toBe(false);
});
it.each(["stop", "close"])("does not carry a pre-hello request across %s", async (retirement) => {
  const { client, connection, connections } = startProtocolHarness({
    resolveClose: () => ({ retry: false, notify: false }),
  });
  const onSent = vi.fn();
  const outcome = client.request("retired", {}, { onSent }).catch((error: unknown) => error);
  if (retirement === "stop") {
    client.stop();
  } else {
    connection.close(1012, "restart");
  }
  await expect(outcome).resolves.toHaveProperty(
    "message",
    retirement === "stop" ? "gateway client stopped" : "gateway closed (1012): restart",
  );
  expect(client.hasPendingRequests).toBe(false);
  client.start();
  const replacement = connections[1];
  assert(replacement);
  receiveConnectChallenge(replacement);
  receiveHello(replacement);
  await vi.advanceTimersByTimeAsync(0);
  const fresh = client.request("fresh");
  expect(replacement.frames.map((frame) => frame.method)).toEqual(["connect", "fresh"]);
  respond(replacement, lastFrame(replacement).id, { healthy: true });
  await expect(fresh).resolves.toEqual({ healthy: true });
  expect(onSent).not.toHaveBeenCalled();
});
it("does not release held requests when async hello acceptance retires its socket", async () => {
  const accepted = createDeferred();
  const onHello = vi.fn();
  const { client, connection, connections } = startProtocolHarness({
    onConnectHello: () => accepted.promise,
    onHello,
  });
  const onSent = vi.fn();
  const retired = client.request("retired", {}, { onSent }).catch((error: unknown) => error);
  receiveConnectChallenge(connection);
  receiveHello(connection);
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.frames.map((frame) => frame.method)).toEqual(["connect"]);
  expect(onHello).not.toHaveBeenCalled();
  client.stop();
  client.start();
  accepted.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await expect(retired).resolves.toHaveProperty("message", "gateway client stopped");
  expect(onSent).not.toHaveBeenCalled();
  expect(onHello).not.toHaveBeenCalled();
  const replacement = connections[1];
  assert(replacement);
  receiveConnectChallenge(replacement);
  receiveHello(replacement);
  await vi.advanceTimersByTimeAsync(0);
  expect(onHello).toHaveBeenCalledOnce();
  expect(replacement.frames.map((frame) => frame.method)).toEqual(["connect"]);
  expect(client.hasPendingRequests).toBe(false);
});
