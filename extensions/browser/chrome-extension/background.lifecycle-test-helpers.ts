import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, vi, type Mock } from "vitest";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { createRelayClient } from "../src/browser/extension-relay/relay-runtime.test-support.js";
import {
  loadBackground,
  loadRelayCommandHarness,
  sendRuntimeMessage,
  TEST_RELAY_KEY,
} from "./background.test-harness.js";
import type { FakeWebSocket } from "./background.test-support.js";

export function deferredScope() {
  const releases = new Set<() => void>();
  return {
    deferred: <T>(fallback: T) => {
      const pending = createDeferred<T>();
      const resolve = (value = fallback) => {
        releases.delete(resolve);
        pending.resolve(value);
      };
      releases.add(resolve);
      return { promise: pending.promise, resolve };
    },
    releaseAll: () => releases.forEach((release) => release()),
  };
}

export type CdpFrame = {
  result?: Record<string, unknown>;
  error?: { message: string };
  params?: { requestId?: string; targetId?: string };
};
export function connectExtension(
  bridge: ExtensionRelayBridge,
  harness: Awaited<ReturnType<typeof loadRelayCommandHarness>>,
  listenForClose = false,
) {
  const extension = bridge.attachExtensionSocket({
    send: (raw) => harness.socket.receive(JSON.parse(raw)),
    close: () => harness.socket.close(),
  });
  if (listenForClose) {
    harness.socket.addEventListener("close", extension.onClose);
  }
  const hello = harness.frames().find((frame) => frame.type === "hello");
  assert(hello);
  harness.socket.send.mockImplementation(extension.onMessage);
  extension.onMessage(JSON.stringify(hello));
}
export function connectCdpClient(bridge: ExtensionRelayBridge) {
  const client = createRelayClient(bridge, undefined, vi.waitFor);
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    client.send(method, sessionId, params);
  const response = async (id: number) => (await client.response(id)) as CdpFrame;
  const request = async (...args: Parameters<typeof send>) => await response(send(...args));
  return {
    send,
    response,
    request,
    close: client.close,
    events: (method: string) => client.frames(method) as CdpFrame[],
    async requestResult(this: void, ...args: Parameters<typeof send>) {
      const frame = await request(...args);
      expect(frame).not.toHaveProperty("error");
      return frame.result;
    },
    root: (...args: Parameters<typeof client.child>) => client.child(...args),
  };
}

export const relayFrames = (socket: FakeWebSocket) =>
  socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

export async function relayReply(socket: FakeWebSocket, message: Record<string, unknown>) {
  const before = relayFrames(socket).length;
  socket.receive(message);
  return await vi.waitFor(() => {
    const response = relayFrames(socket)
      .slice(before)
      .find((frame) =>
        message.type === "ping" ? frame.type === "pong" : frame.seq === message.seq,
      );
    expect(response).toBeDefined();
    return response;
  });
}

type BackgroundOptions = NonNullable<Parameters<typeof loadBackground>[0]>;
export function loadConfiguredBackground(
  accessMode: string,
  tabs: Array<number | NonNullable<BackgroundOptions["initialTabs"]>[number]> = [],
  options: BackgroundOptions = {},
) {
  return loadBackground({
    storedConfig: relayConfig(accessMode),
    initialTabs: tabs.map((tab) => ({
      url: "https://example.com/",
      groupId: -1,
      ...(typeof tab === "number" ? { id: tab } : tab),
    })),
    ...options,
  });
}

export async function connectRelay(harness: Awaited<ReturnType<typeof loadBackground>>) {
  const socket = harness.relaySockets[0]!;
  expect(socket).toBeDefined();
  await harness.authenticate(socket);
  let seq = 1000;
  const request = async (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
    await relayReply(socket, { ...message, seq: ++seq });
  return { socket, frames: () => relayFrames(socket), request };
}

export const runtime = (
  harness: Parameters<typeof sendRuntimeMessage>[0],
  type: string,
  fields: Record<string, unknown> = {},
) => sendRuntimeMessage(harness, { type, ...fields });

export const relayConfig = (accessMode = "all") => ({
  relayUrl: "ws://127.0.0.1:18797/extension",
  token: TEST_RELAY_KEY,
  authVersion: 2,
  accessMode,
});

export const createTab = (url = "about:blank") => ({ type: "createTab", url });
export const cdp = (method: string, params?: Record<string, unknown>, tabId = 101) => ({
  type: "cdp",
  tabId,
  method,
  ...(params === undefined ? {} : { params }),
});

export const expectType = (response: unknown, type = "result") =>
  expect(response).toMatchObject({ type });

export const expectResult = (response: unknown, result: Record<string, unknown>) =>
  expect(response).toMatchObject({ type: "result", result });

export const expectUnused = (...mocks: unknown[]) =>
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());

export async function waitCalled(mock: unknown, ...args: unknown[]) {
  await vi.waitFor(() =>
    args.length ? expect(mock).toHaveBeenCalledWith(...args) : expect(mock).toHaveBeenCalled(),
  );
}

export function holdNext<Args extends unknown[], Result>(
  mock: Mock<(...args: Args) => Promise<Result>>,
  gate: Promise<void>,
): Mock<(...args: Args) => Promise<Result>> {
  const original = mock.getMockImplementation()!;
  mock.mockImplementationOnce(async (...args) => {
    await gate;
    return await original(...args);
  });
  return mock;
}
