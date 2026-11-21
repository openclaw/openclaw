import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, onTestFinished } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { FakeSocket, flush, sendHello, wireExtension } from "./relay-bridge.test-support.js";

const CONTEXT_CREATED = "Runtime.executionContextCreated";
type Params = Record<string, unknown>;

export function runtimeContext(id: number) {
  return {
    id,
    uniqueId: `context-${id}`,
    origin: "https://example.com",
    name: "",
    auxData: { isDefault: true, frameId: "target-1" },
  };
}

export const autoAttachParams = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export function createRelayClient(
  bridge: ExtensionRelayBridge,
  rootParams: Params = { autoAttach: true },
  wait: <T>(read: () => T) => Promise<T> = async (read) => {
    await flush();
    return read();
  },
) {
  const socket = new FakeSocket();
  const handlers = bridge.attachCdpClientSocket(socket);
  let nextId = 0;
  const byId = (id: number) => socket.frames().find((entry) => entry.id === id);
  const frames = (method: string) => socket.frames().filter((frame) => frame.method === method);
  function send(method: string, sessionId?: string, params?: Params) {
    const id = ++nextId;
    handlers.onMessage(JSON.stringify({ id, method, sessionId, params }));
    return id;
  }
  const response = (id: number, method?: string) =>
    wait(() => {
      const reply = byId(id);
      expect(reply, method).toBeDefined();
      return reply!;
    });
  const request = async (method: string, sessionId?: string, params?: Params) =>
    await response(send(method, sessionId, params), method);
  const attached = (parent?: string) =>
    frames("Target.attachedToTarget")
      .filter((frame) => frame.sessionId === parent)
      .map((frame) => asOptionalRecord(frame.params)!);
  function readSession(value: unknown) {
    const id = asOptionalRecord(value)?.sessionId;
    if (typeof id !== "string") {
      throw new Error("Missing logical attachment");
    }
    return id;
  }
  const latestChild = (parent?: string) => readSession(attached(parent).at(-1));
  const session = async (method: string, parent?: string, params?: Params) =>
    readSession((await request(method, parent, params)).result);
  return {
    socket,
    handlers,
    frame: byId,
    frames,
    latestChild,
    send,
    response,
    request,
    attached,
    async attach() {
      expect((await request("Target.setAutoAttach", undefined, rootParams)).error).toBeUndefined();
      return latestChild();
    },
    async autoAttach(parent: string) {
      expect(
        (await request("Target.setAutoAttach", parent, autoAttachParams)).error,
      ).toBeUndefined();
    },
    child(targetId: string, parent?: string) {
      const announcement = frames("Target.attachedToTarget").findLast(
        (frame) =>
          (parent === undefined || frame.sessionId === parent) &&
          asOptionalRecord(asOptionalRecord(frame.params)?.targetInfo)?.targetId === targetId,
      );
      return readSession(announcement?.params);
    },
    session,
    alias: () =>
      session("Target.attachToTarget", undefined, { targetId: "target-1", flatten: true }),
    close: handlers.onClose,
  };
}

export function createRuntimeFixture() {
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => bridge.dispose());
  const enabled = new Set<string>();
  const held: number[] = [];
  let heldMethod: string | undefined;
  let accessAllowed = true;
  let contextOffset = -10;
  const extension = wireExtension(bridge, (msg) => {
    if (msg.type === "ping") {
      return null;
    }
    if (msg.type === "attach") {
      enabled.clear();
      contextOffset += 10;
      return { type: "result", seq: msg.seq, result: { targetId: `target-${msg.tabId}` } };
    }
    if (msg.type === "cdp") {
      const key = msg.sessionId ?? "root";
      if (msg.method === "Runtime.enable") {
        if (!accessAllowed) {
          return { type: "error", seq: msg.seq, message: "tab access was revoked" };
        }
        // V8 reports existing contexts only on the physical disabled -> enabled transition.
        if (!enabled.has(key)) {
          enabled.add(key);
          event(
            CONTEXT_CREATED,
            { context: runtimeContext(key === "root" ? 1 + contextOffset : 2) },
            msg.sessionId,
          );
        }
      }
      if (msg.method === "Runtime.disable") {
        enabled.delete(key);
      }
      if (msg.method === heldMethod) {
        held.push(msg.seq);
        return null;
      }
    }
    return { type: "result", seq: msg.seq, result: {} };
  });
  function event(method: string, params: unknown, sessionId?: string) {
    extension.handlers.onMessage(
      JSON.stringify({ type: "cdpEvent", tabId: 1, sessionId, method, params }),
    );
  }
  sendHello(extension.handlers);
  return {
    bridge,
    extension,
    event,
    client: () => createRelayClient(bridge),
    commands: (method: string) =>
      extension.socket.frames().filter((frame) => frame.method === method),
    revokeAccess: () => {
      accessAllowed = false;
    },
    hold: (method = "Runtime.enable") => {
      heldMethod = method;
    },
    release: () => {
      heldMethod = undefined;
      for (const seq of held.splice(0)) {
        extension.handlers.onMessage(JSON.stringify({ type: "result", seq, result: {} }));
      }
    },
  };
}

export function createdRuntimeContexts(socket: FakeSocket, sessionId: string) {
  return socket
    .frames()
    .filter((frame) => frame.sessionId === sessionId && frame.method === CONTEXT_CREATED);
}

export function expectContextBeforeResult(
  socket: FakeSocket,
  sessionId: string,
  id: unknown,
  contexts = [runtimeContext(1)],
) {
  const frames = socket.frames();
  const created = createdRuntimeContexts(socket, sessionId);
  const resultIndex = frames.findIndex((frame) => frame.id === id);
  expect(resultIndex).toBeGreaterThanOrEqual(0);
  expect(created.map((frame) => frame.params)).toEqual(
    contexts.map((value) => ({ context: value })),
  );
  for (const frame of created) {
    expect(frames.indexOf(frame)).toBeLessThan(resultIndex);
  }
}
