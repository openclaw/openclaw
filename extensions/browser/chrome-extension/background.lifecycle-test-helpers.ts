import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, vi, type Mock } from "vitest";
import type { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import { FakeSocket } from "../src/browser/extension-relay/relay-bridge.test-support.js";
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
      const release = () => pending.resolve(fallback);
      releases.add(release);
      return {
        promise: pending.promise,
        resolve: (value = fallback) => {
          releases.delete(release);
          pending.resolve(value);
        },
      };
    },
    releaseAll: () => {
      for (const release of releases) {
        release();
      }
      releases.clear();
    },
  };
}

export type CdpFrame = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
  params?: {
    sessionId?: string;
    requestId?: string;
    targetId?: string;
    targetInfo?: { targetId?: string };
  };
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
  const socket = new FakeSocket();
  const handlers = bridge.attachCdpClientSocket(socket);
  const frames = () => socket.frames() as CdpFrame[];
  let id = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const requestId = ++id;
    handlers.onMessage(JSON.stringify({ id: requestId, method, params, sessionId }));
    return requestId;
  };
  const response = (requestId: number) =>
    vi.waitFor(() => {
      const frame = frames().find((entry) => entry.id === requestId);
      assert(frame, `missing CDP reply ${requestId}`);
      return frame;
    });
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) => await response(send(method, params, sessionId));
  return {
    frames,
    send,
    response,
    request,
    close: handlers.onClose,
    events: (method: string) => frames().filter((frame) => frame.method === method),
    async requestResult(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      const frame = await request(method, params, sessionId);
      expect(frame).not.toHaveProperty("error");
      return frame.result;
    },
    root(targetId: string) {
      const session = frames().find(
        (frame) =>
          frame.method === "Target.attachedToTarget" &&
          frame.params?.targetInfo?.targetId === targetId,
      )?.params?.sessionId;
      assert(typeof session === "string");
      return session;
    },
  };
}

export const relayFrames = (socket: FakeWebSocket) =>
  socket.send.mock.calls.map(([raw]) => JSON.parse(raw));

export function relayRequest(socket: FakeWebSocket, firstSeq = 1000) {
  let seq = firstSeq;
  return async (message: Record<string, unknown>) => {
    const id = ++seq;
    socket.receive({ ...message, seq: id });
    return await vi.waitFor(() => {
      const response = relayFrames(socket).find((frame) => frame.seq === id);
      expect(response).toBeDefined();
      return response;
    });
  };
}

export async function connectRelay(harness: Awaited<ReturnType<typeof loadBackground>>) {
  const socket = harness.relaySockets[0]!;
  expect(socket).toBeDefined();
  await harness.authenticate(socket);
  return { socket, frames: () => relayFrames(socket), request: relayRequest(socket) };
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

export function expectType(response: unknown, type = "result") {
  expect(response).toMatchObject({ type });
}

export function expectUnused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function waitCalled(mock: unknown, ...args: unknown[]) {
  await vi.waitFor(() => {
    if (args.length) {
      expect(mock).toHaveBeenCalledWith(...args);
    } else {
      expect(mock).toHaveBeenCalled();
    }
  });
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
