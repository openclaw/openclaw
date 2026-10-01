import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Extension relay bridge: CDP target synthesis and extension command routing.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  FakeSocket,
  wireExtension,
  sendHello,
  defaultTabs,
  flush,
  replyFor,
} from "./relay-bridge.test-support.js";
import type { RelayToExtensionMessage } from "./relay-protocol.js";

function response(socket: FakeSocket, id: number) {
  return socket.frames().find((frame) => frame.id === id);
}

function events(socket: FakeSocket, method: string) {
  return socket.frames().filter((frame) => frame.method === method);
}

function deliver(receiver: { onMessage(raw: string): void }, message: unknown) {
  receiver.onMessage(JSON.stringify(message));
}

function createBridge() {
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => {
    bridge.dispose();
    vi.useRealTimers();
  });
  return bridge;
}

async function attachClient(bridge: ExtensionRelayBridge) {
  const client = new FakeSocket();
  const cdp = bridge.attachCdpClientSocket(client);
  deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
  await flush();
  return { client, cdp };
}

async function holdCdpCommand(
  bridge: ExtensionRelayBridge,
  method: string,
  params: Record<string, unknown> = {},
) {
  const extension = wireExtension(bridge, (message) =>
    message.type === "cdp" && message.method === method ? null : replyFor(message),
  );
  const send = extension.socket.send.bind(extension.socket);
  extension.socket.send = (raw) => {
    send(raw);
    if (JSON.parse(raw).type === "ping") {
      deliver(extension.handlers, { type: "pong" });
    }
  };
  sendHello(extension.handlers);
  const client = new FakeSocket();
  const cdp = bridge.attachCdpClientSocket(client);
  deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
  await vi.advanceTimersByTimeAsync(0);
  const sessionId = asOptionalRecord(
    client.frames().find((frame) => frame.method === "Target.attachedToTarget")?.params,
  )?.sessionId;
  deliver(cdp, { id: 2, sessionId, method, params });
  return { extension, client, cdp, sessionId };
}

describe("ExtensionRelayBridge", () => {
  it.each(["Runtime.callFunctionOn", "Runtime.evaluate", "Runtime.awaitPromise"])(
    "lets an awaited %s reply finish after the ordinary command deadline",
    async (method) => {
      vi.useFakeTimers();
      const bridge = createBridge();
      const { extension, client } = await holdCdpCommand(bridge, method, { awaitPromise: true });
      await vi.advanceTimersByTimeAsync(17_000);
      expect(response(client, 2)).toBeUndefined();
      const command = extension.socket
        .frames()
        .find((frame) => frame.type === "cdp" && frame.method === method);
      deliver(extension.handlers, {
        type: "result",
        seq: command?.seq,
        result: { result: { value: true } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(response(client, 2)).toMatchObject({
        result: { result: { value: true } },
      });
    },
  );

  it("keeps the ordinary Runtime deadline without an awaited promise", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { client } = await holdCdpCommand(bridge, "Runtime.evaluate");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(response(client, 2)).toMatchObject({
      error: { message: "extension relay command timed out: cdp" },
    });
  });

  it("bounds awaited Runtime work beyond the maximum supported action wait", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { client } = await holdCdpCommand(bridge, "Runtime.callFunctionOn", {
      awaitPromise: true,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(response(client, 2)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(response(client, 2)).toMatchObject({
      error: { message: "extension relay command timed out: cdp" },
    });
    expect(bridge.extensionConnected).toBe(true);
  });

  it.each(["detach", "heartbeat"])("retires an awaited Runtime reply on %s loss", async (loss) => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { client, extension, cdp, sessionId } = await holdCdpCommand(
      bridge,
      "Runtime.callFunctionOn",
      { awaitPromise: true },
    );
    await vi.advanceTimersByTimeAsync(17_000);
    expect(response(client, 2)).toBeUndefined();
    if (loss === "detach") {
      deliver(cdp, { id: 3, method: "Target.detachFromTarget", params: { sessionId } });
      await vi.advanceTimersByTimeAsync(0);
      expect(response(client, 3)).toMatchObject({ result: {} });
    } else {
      extension.socket.send = (raw) => FakeSocket.prototype.send.call(extension.socket, raw);
      await vi.advanceTimersByTimeAsync(43_000);
      expect(bridge.extensionConnected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(response(client, 2)).toMatchObject({
      error: {
        message: loss === "detach" ? "Physical session detached" : "extension disconnected",
      },
    });
  });
  it("notifies connection waiters only after an authenticated valid hello", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const pending = wireExtension(bridge);
    let ready = false;
    const connected = bridge
      .waitForExtensionConnection(new AbortController().signal, 8_000)
      .then((result) => {
        ready = result;
      });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(ready).toBe(false);
    deliver(pending.handlers, { type: "not-hello" });
    await vi.advanceTimersByTimeAsync(100);
    expect(ready).toBe(false);

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    await connected;

    expect(ready).toBe(true);
    expect(bridge.extensionConnected).toBe(true);
    bridge.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases pending connection waiters immediately when their relay is disposed", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const waiting = bridge.waitForExtensionConnection(new AbortController().signal, 8_000);

    bridge.dispose();

    await expect(waiting).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a replacement extension its own heartbeat budget and ignores stale owners", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const previous = wireExtension(bridge);
    sendHello(previous.handlers);
    await vi.advanceTimersByTimeAsync(40_000);

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    expect(previous.socket.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(40_000);
    deliver(previous.handlers, { type: "pong" });
    previous.handlers.onClose();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(replacement.socket.closed).toBe(false);
    expect(bridge.extensionConnected).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(replacement.socket).toMatchObject({
      closed: true,
      closeCode: 4000,
      closeReason: "extension heartbeat timeout",
    });
    expect(bridge.extensionConnected).toBe(false);
  });

  it("multiplexes Playwright page CDP sessions over the accessible tab attachment", async () => {
    const bridge = createBridge();
    const { socket: extSocket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const { client, cdp } = await attachClient(bridge);
    deliver(cdp, { id: 2, method: "Target.attachToBrowserTarget" });
    await flush();
    const browserSessionId = (response(client, 2)?.result as { sessionId?: string })?.sessionId;
    expect(browserSessionId).toBeTruthy();

    deliver(cdp, {
      id: 3,
      sessionId: browserSessionId,
      method: "Target.attachToTarget",
      params: { targetId: "target-1", flatten: true },
    });
    await flush();
    const pageSessionId = (response(client, 3)?.result as { sessionId?: string })?.sessionId;
    expect(pageSessionId).toBeTruthy();
    expect(pageSessionId).not.toBe(browserSessionId);

    deliver(cdp, { id: 4, sessionId: pageSessionId, method: "Runtime.evaluate", params: {} });
    await flush();
    expect(
      extSocket
        .frames()
        .find((frame) => frame.type === "cdp" && frame.method === "Runtime.evaluate"),
    ).toMatchObject({ tabId: 1, method: "Runtime.evaluate" });
    expect(response(client, 4)?.result).toMatchObject({ ok: true });

    deliver(cdp, { id: 6, sessionId: pageSessionId, method: "Runtime.enable" });
    await flush();
    deliver(handlers, {
      type: "cdpEvent",
      tabId: 1,
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });
    await flush();
    expect(
      client
        .frames()
        .find(
          (frame) =>
            frame.sessionId === pageSessionId && frame.method === "Runtime.consoleAPICalled",
        ),
    ).toMatchObject({ params: { type: "log" } });

    const otherClient = new FakeSocket();
    const otherCdp = bridge.attachCdpClientSocket(otherClient);
    deliver(otherCdp, {
      id: 1,
      method: "Target.detachFromTarget",
      params: { sessionId: pageSessionId },
    });
    await flush();
    expect(response(otherClient, 1)?.error).toMatchObject({
      code: -32001,
    });

    deliver(cdp, {
      id: 5,
      sessionId: browserSessionId,
      method: "Target.detachFromTarget",
      params: { sessionId: pageSessionId },
    });
    await flush();
    expect(response(client, 5)?.result).toEqual({});
  });

  it("creates a tab inside the group and returns its synthetic target", async () => {
    const bridge = createBridge();
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const { client, cdp } = await attachClient(bridge);
    deliver(cdp, { id: 2, method: "Target.createTarget", params: { url: "https://new.test" } });
    await flush();

    const reply = response(client, 2);
    expect(reply?.result).toMatchObject({ targetId: "target-999" });
    expect(socket.frames().find((frame) => frame.type === "createTab")).toMatchObject({
      url: "https://new.test",
      background: true,
      focus: false,
    });
  });

  it.each(["active", "replaced extension"])(
    "binds an atomic creation reply to its current owner: %s",
    async (lifecycle) => {
      const bridge = createBridge();
      const socket = new FakeSocket();
      const extension = bridge.attachExtensionSocket(socket);
      sendHello(extension, []);
      const client = new FakeSocket();
      const cdp = bridge.attachCdpClientSocket(client);
      deliver(cdp, { id: 1, method: "Target.createTarget", params: { url: "" } });
      const command = socket.frames().at(-1);
      expect(command).toMatchObject({ type: "createTab", url: "about:blank" });
      deliver(extension, {
        type: "result",
        seq: command?.seq,
        result: { tabId: 99, targetId: "created-target" },
      });
      // Resolve the old promise, then replace its owner before its continuation.

      if (lifecycle === "replaced extension") {
        sendHello(wireExtension(bridge).handlers, []);
      }
      await flush();

      expect(socket.frames().filter((frame) => frame.type === "attach")).toEqual([]);
      if (lifecycle === "active") {
        expect(client.frames().map((frame) => frame.method ?? frame.id)).toEqual([
          "Target.attachedToTarget",
          1,
        ]);
        expect(client.frames().at(-1)?.result).toEqual({ targetId: "created-target" });
      } else {
        expect(client.frames()).toEqual([]);
        expect(bridge.accessibleTabs()).toEqual([]);
        expect(socket.frames().filter((frame) => frame.type === "detach")).toEqual([]);
      }
    },
  );

  it("honors an explicit Target.createTarget focus request", async () => {
    const bridge = createBridge();
    const { socket, handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, {
      id: 1,
      method: "Target.createTarget",
      params: { url: "https://focused.test", focus: true },
    });
    await flush();

    expect(response(client, 1)?.result).toMatchObject({
      targetId: "target-999",
    });
    expect(socket.frames().find((frame) => frame.type === "createTab")).toMatchObject({
      url: "https://focused.test",
      background: false,
      focus: true,
    });
  });

  it("rejects isolated browser contexts (real profile only)", async () => {
    const bridge = createBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, { id: 1, method: "Target.createBrowserContext" });
    await flush();

    const reply = response(client, 1);
    expect(reply?.error).toBeTruthy();
  });

  it("reports malformed CDP client JSON instead of leaving the client waiting", () => {
    const bridge = createBridge();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    cdp.onMessage("{");

    expect(client.frames()).toEqual([
      { id: null, error: { code: -32700, message: "Parse error" } },
    ]);
  });

  it("reports invalid CDP client requests instead of leaving the client waiting", () => {
    const bridge = createBridge();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    deliver(cdp, { id: 7, sessionId: "session-1", params: {} });

    expect(client.frames()).toEqual([
      {
        id: 7,
        sessionId: "session-1",
        error: { code: -32600, message: "Invalid request" },
      },
    ]);
  });

  it("keeps the active extension while a candidate is pending, malformed, or closed", () => {
    const bridge = createBridge();
    const active = wireExtension(bridge);
    sendHello(active.handlers);

    const pendingSocket = new FakeSocket();
    const pending = bridge.attachExtensionSocket(pendingSocket);
    expect(active.socket.closed).toBe(false);
    expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");

    pending.onClose();
    sendHello(pending);
    expect(bridge.extensionConnected).toBe(true);
    expect(active.socket.closed).toBe(false);

    const malformedSocket = new FakeSocket();
    const malformed = bridge.attachExtensionSocket(malformedSocket);
    deliver(malformed, {
      type: "hello",
      userAgent: "candidate",
      browserVersion: "Chrome/145.0.0.0",
      extensionVersion: "2.0.0",
    });
    expect(malformedSocket).toMatchObject({
      closed: true,
      closeCode: 4001,
      closeReason: "expected valid hello",
    });
    expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");
    expect(active.socket.closed).toBe(false);
  });

  it("rejects an older candidate when a newer candidate promotes first", () => {
    const bridge = createBridge();
    const active = wireExtension(bridge);
    sendHello(active.handlers);

    const firstSocket = new FakeSocket();
    const first = bridge.attachExtensionSocket(firstSocket);
    const secondSocket = new FakeSocket();
    const second = bridge.attachExtensionSocket(secondSocket);
    expect(active.socket.closed).toBe(false);

    deliver(second, {
      type: "hello",
      userAgent: "second",
      browserVersion: "Chrome/146.0.0.0",
      extensionVersion: "2.0.0",
      tabs: [],
    });
    expect(active.socket.closed).toBe(true);
    expect(firstSocket.closed).toBe(false);
    expect(secondSocket.closed).toBe(false);
    expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");

    deliver(first, {
      type: "hello",
      userAgent: "first",
      browserVersion: "Chrome/145.0.0.0",
      extensionVersion: "2.0.0",
      tabs: [],
    });
    expect(firstSocket).toMatchObject({
      closed: true,
      closeCode: 4000,
      closeReason: "superseded by newer extension connection",
    });
    expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");

    first.onClose();
    active.handlers.onClose();
    expect(bridge.extensionConnected).toBe(true);
    expect(secondSocket.closed).toBe(false);
  });

  it("answers the Puppeteer connect bootstrap without protocol errors", async () => {
    const bridge = createBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    const bootstrap: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [
      { id: 1, method: "Browser.getVersion" },
      { id: 2, method: "Target.setDiscoverTargets", params: { discover: true } },
      {
        id: 3,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      },
      { id: 4, method: "Target.getBrowserContexts" },
    ];
    for (const message of bootstrap) {
      deliver(cdp, message);
    }
    await flush();

    for (const message of bootstrap) {
      const reply = response(client, message.id);
      expect(reply, `response for ${message.method}`).toBeTruthy();
      expect(reply?.error, `error for ${message.method}`).toBeUndefined();
    }
    expect(response(client, 1)?.result).toMatchObject({
      protocolVersion: "1.3",
      product: "Chrome/144.0.0.0",
    });
    const contexts = response(client, 4);

    expect(contexts?.result).toEqual({ browserContextIds: [] });
  });

  it("lists accessible tabs as DevTools-style target descriptors", async () => {
    const bridge = createBridge();
    const { handlers } = wireExtension(bridge);
    sendHello(handlers);

    expect(bridge.devtoolsTargetDescriptors()).toEqual([
      {
        tabId: 1,
        url: "https://example.com",
        title: "Example",
        active: true,
        id: "tab-1",
        type: "page",
      },
    ]);

    await attachClient(bridge);

    expect(bridge.devtoolsTargetDescriptors()[0]).toMatchObject({ id: "target-1", type: "page" });
  });

  it("keeps operation identity on the same granted tab across renderer reattachment", async () => {
    const bridge = createBridge();
    let targetId = "original-target";
    const extension = wireExtension(bridge, (command) =>
      command.type === "attach"
        ? { type: "result", seq: command.seq, result: { targetId } }
        : replyFor(command),
    );
    sendHello(extension.handlers);
    const { client, cdp } = await attachClient(bridge);
    const resolveTarget = bridge.captureOperationTarget("original-target");
    expect(resolveTarget?.()).toBe("original-target");

    deliver(extension.handlers, { type: "detached", tabId: 1, reason: "renderer replaced" });
    expect(resolveTarget?.()).toBeUndefined();
    targetId = "replacement-target";
    deliver(cdp, { id: 2, method: "Target.getTargets" });
    await flush();

    expect(response(client, 2)?.error).toBeUndefined();
    expect(resolveTarget?.()).toBe("replacement-target");
  });

  it("invalidates captured operation identity when access is revoked and regranted", async () => {
    const bridge = createBridge();
    const extension = wireExtension(bridge);
    sendHello(extension.handlers);
    const cdp = bridge.attachCdpClientSocket(new FakeSocket());
    deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await flush();
    const resolveTarget = bridge.captureOperationTarget("target-1");

    deliver(extension.handlers, { type: "tabs", tabs: [] });
    deliver(extension.handlers, { type: "tabs", tabs: defaultTabs() });
    await flush();

    expect(resolveTarget?.()).toBeUndefined();
    expect(bridge.captureOperationTarget("target-1")?.()).toBe("target-1");
  });

  it("invalidates captured operation identity when another extension reconnects", async () => {
    const bridge = createBridge();
    const original = wireExtension(bridge);
    sendHello(original.handlers);
    const cdp = bridge.attachCdpClientSocket(new FakeSocket());
    deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await flush();
    const resolveTarget = bridge.captureOperationTarget("target-1");

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    await flush();

    expect(resolveTarget?.()).toBeUndefined();
    expect(bridge.captureOperationTarget("target-1")?.()).toBe("target-1");
  });
});

describe("ExtensionRelayBridge target enumeration", () => {
  it.each(["target_closed", "canceled_by_user"])(
    "honors subscriptions and cancellation after native %s",
    async (reason) => {
      const bridge = createBridge();
      let targetId = "original-target";
      const extension = wireExtension(bridge, (message) =>
        message.type === "attach"
          ? { type: "result", seq: message.seq, result: { targetId } }
          : replyFor(message),
      );
      sendHello(extension.handlers);
      const first = new FakeSocket();
      const firstCdp = bridge.attachCdpClientSocket(first);
      const second = new FakeSocket();
      const secondCdp = bridge.attachCdpClientSocket(second);
      for (const cdp of [firstCdp, secondCdp]) {
        deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
      }
      await flush();
      const original = first.frames().find((frame) => frame.method === "Target.attachedToTarget");
      const sessionId = (original?.params as { sessionId?: string } | undefined)?.sessionId;
      expect(typeof sessionId).toBe("string");
      deliver(firstCdp, { id: 2, method: "Target.detachFromTarget", params: { sessionId } });
      await flush();

      targetId = "replacement-target";
      deliver(extension.handlers, { type: "detached", tabId: 1, reason });
      await flush();
      deliver(extension.handlers, {
        type: "tabs",
        tabs: [{ tabId: 1, url: "https://example.com/next", title: "Next", active: true }],
      });
      await flush();

      const recovered = reason === "target_closed";
      expect(events(first, "Target.attachedToTarget")).toHaveLength(1);
      const attached = events(second, "Target.attachedToTarget");
      expect(attached).toHaveLength(recovered ? 2 : 1);
      expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(
        recovered ? 2 : 1,
      );
      if (recovered) {
        expect(attached[1]?.params).toMatchObject({
          sessionId: expect.not.stringMatching(`^${sessionId}$`),
          targetInfo: { targetId: "replacement-target" },
        });
      }
      deliver(secondCdp, {
        id: 3,
        sessionId,
        method: "Runtime.evaluate",
        params: { expression: "1" },
      });
      await flush();
      expect(response(second, 3)?.error).toBeDefined();
      expect(
        extension.socket
          .frames()
          .filter((frame) => frame.type === "cdp" && frame.method === "Runtime.evaluate"),
      ).toHaveLength(0);
    },
  );

  it.each(["client close", "tab removal", "user cancellation"])(
    "rechecks recovery recipients after %s while native attachment is pending",
    async (ending) => {
      const bridge = createBridge();
      const recovery = createDeferred<RelayToExtensionMessage>();
      let attachAttempts = 0;
      const extension = wireExtension(bridge, (message) => {
        if (message.type === "attach" && ++attachAttempts > 1) {
          recovery.resolve(message);
          return null;
        }
        return replyFor(message);
      });
      sendHello(extension.handlers);
      const first = new FakeSocket();
      const firstCdp = bridge.attachCdpClientSocket(first);
      const second = new FakeSocket();
      const secondCdp = bridge.attachCdpClientSocket(second);
      for (const cdp of [firstCdp, secondCdp]) {
        deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
      }
      await flush();
      deliver(extension.handlers, { type: "detached", tabId: 1, reason: "target_closed" });
      const pending = await recovery.promise;
      const closing = ending === "client close" ? firstCdp.onClose() : Promise.resolve();
      if (ending === "tab removal") {
        deliver(extension.handlers, { type: "tabs", tabs: [] });
      } else if (ending === "user cancellation") {
        deliver(extension.handlers, { type: "detached", tabId: 1, reason: "canceled_by_user" });
      }
      deliver(extension.handlers, replyFor(pending));
      await closing;
      await flush();

      expect(events(first, "Target.attachedToTarget")).toHaveLength(1);
      expect(events(second, "Target.attachedToTarget")).toHaveLength(
        ending === "client close" ? 2 : 1,
      );
      expect(attachAttempts).toBe(2);
    },
  );

  it("includes a tab discovered while another native attachment is pending", async () => {
    const bridge = createBridge();
    const firstAttach = createDeferred<RelayToExtensionMessage>();
    const nextStep = createDeferred<Record<string, unknown>>();
    const extension = wireExtension(bridge, (message) => {
      if (message.type !== "attach") {
        return replyFor(message);
      }
      if (message.tabId === 1) {
        firstAttach.resolve(message);
      } else {
        nextStep.resolve(message);
      }
      return null;
    });
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const send = client.send.bind(client);
    client.send = (data) => {
      send(data);
      nextStep.resolve(JSON.parse(data));
    };
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, { id: 1, method: "Target.getTargets" });
    const first = await firstAttach.promise;
    deliver(extension.handlers, {
      type: "tabs",
      tabs: [
        { tabId: 1, url: "https://one.example", title: "One", active: true },
        { tabId: 2, url: "https://two.example", title: "Two", active: false },
      ],
    });
    deliver(extension.handlers, replyFor(first));
    const second = await nextStep.promise;
    expect(second).toMatchObject({ type: "attach", tabId: 2 });
    deliver(extension.handlers, {
      type: "result",
      seq: second.seq,
      result: { targetId: "target-2" },
    });
    await flush();
    expect(response(client, 1)).toMatchObject({
      result: {
        targetInfos: [
          expect.objectContaining({ targetId: "target-1" }),
          expect.objectContaining({ targetId: "target-2" }),
        ],
      },
    });
  });

  it("repairs reconnect attach without undoing a later explicit detach", async () => {
    const bridge = createBridge();
    const initialSocket = new FakeSocket();
    const initial = bridge.attachExtensionSocket(initialSocket);
    sendHello(initial);

    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    expect(initialSocket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);

    const replacement = wireExtension(bridge);
    sendHello(replacement.handlers);
    await flush();

    expect(replacement.socket.frames().filter((frame) => frame.type === "attach")).toEqual([
      expect.objectContaining({ tabId: 1 }),
    ]);
    deliver(cdp, { id: 2, method: "Target.getTargets" });
    await flush();
    expect(response(client, 2)?.result).toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "target-1" })],
    });

    const peer = new FakeSocket();
    const peerCdp = bridge.attachCdpClientSocket(peer);
    deliver(peerCdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await flush();
    const attached = client
      .frames()
      .findLast((frame) => frame.method === "Target.attachedToTarget");
    const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof sessionId).toBe("string");
    deliver(cdp, { id: 3, method: "Target.detachFromTarget", params: { sessionId } });
    await flush();
    const attachedEventCount = events(client, "Target.attachedToTarget").length;
    const peerAttachedEventCount = events(peer, "Target.attachedToTarget").length;
    const afterDetach = wireExtension(bridge);
    sendHello(afterDetach.handlers, [
      { tabId: 1, url: "https://example.com", title: "Updated", active: true },
    ]);
    await flush();

    expect(afterDetach.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(events(client, "Target.attachedToTarget")).toHaveLength(attachedEventCount);
    expect(events(peer, "Target.attachedToTarget")).toHaveLength(peerAttachedEventCount + 1);
    deliver(cdp, { id: 4, method: "Target.getTargets" });
    await flush();
    expect(afterDetach.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(response(client, 4)?.result).toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "target-1", attached: true })],
    });
    expect(events(client, "Target.attachedToTarget")).toHaveLength(attachedEventCount);

    deliver(afterDetach.handlers, { type: "tabs", tabs: [] });
    deliver(afterDetach.handlers, {
      type: "tabs",
      tabs: [{ tabId: 1, url: "https://reused.example", title: "Reused", active: true }],
    });
    await flush();
    expect(events(client, "Target.attachedToTarget")).toHaveLength(attachedEventCount + 1);
  });

  it("does not project a disconnected zero-tab extension as authoritative empty", async () => {
    const bridge = createBridge();
    const extension = wireExtension(bridge);
    sendHello(extension.handlers, []);
    extension.handlers.onClose();
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    deliver(cdp, { id: 1, method: "Target.getTargets" });
    await flush();

    expect(response(client, 1)).toMatchObject({
      error: { message: expect.stringMatching(/extension.*disconnected/i) },
    });
  });

  it("refreshes native identities without attaching a discovery-only client", async () => {
    const bridge = createBridge();
    let targetId = "target-1";
    let unavailable = false;
    const extension = wireExtension(bridge, (message) =>
      message.type === "attach"
        ? unavailable
          ? { type: "error", seq: message.seq, message: "native target unavailable" }
          : { type: "result", seq: message.seq, result: { targetId } }
        : replyFor(message),
    );
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);

    deliver(cdp, { id: 1, method: "Target.getTargets" });
    await flush();

    expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(1);
    expect(response(client, 1)).toMatchObject({
      result: {
        targetInfos: [expect.objectContaining({ targetId: "target-1", attached: false })],
      },
    });
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(false);

    targetId = "replacement-target";
    deliver(cdp, { id: 2, method: "Target.getTargets" });
    await flush();

    expect(response(client, 2)).toMatchObject({
      result: {
        targetInfos: [expect.objectContaining({ targetId: "replacement-target", attached: false })],
      },
    });
    expect(client.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(false);

    unavailable = true;
    deliver(cdp, { id: 3, method: "Target.getTargets" });
    await flush();
    expect(response(client, 3)).toMatchObject({
      error: { message: "Target identities are unavailable" },
    });
  });

  it("rejects discovery when the previous native retirement fails", async () => {
    const bridge = createBridge();
    const retirement = createDeferred<Extract<RelayToExtensionMessage, { type: "detach" }>>();
    const extension = wireExtension(bridge, (message) => {
      if (message.type === "detach") {
        retirement.resolve(message);
        return null;
      }
      return replyFor(message);
    });
    sendHello(extension.handlers);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, { id: 1, method: "Target.getTargets" });
    const detach = await retirement.promise;
    deliver(cdp, { id: 2, method: "Target.getTargets" });
    deliver(extension.handlers, {
      type: "error",
      seq: detach.seq,
      message: "native detach failed",
    });
    await flush();

    expect(response(client, 2)).toMatchObject({
      error: { message: "Target identities are unavailable" },
    });
  });

  it("publishes a shared recovered attachment to every waiting auto-attach client", async () => {
    const bridge = createBridge();
    let attachAttempts = 0;
    const extension = wireExtension(bridge, (message) => {
      if (message.type === "attach" && attachAttempts++ === 0) {
        return { type: "error", seq: message.seq, message: "first client lost its claim" };
      }
      return replyFor(message);
    });
    sendHello(extension.handlers);
    const first = new FakeSocket();
    const firstCdp = bridge.attachCdpClientSocket(first);
    deliver(firstCdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await flush();

    const second = new FakeSocket();
    const secondCdp = bridge.attachCdpClientSocket(second);
    deliver(secondCdp, { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } });
    await flush();
    expect(second.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(true);
    expect(first.frames().some((frame) => frame.method === "Target.attachedToTarget")).toBe(true);
    const firstAttachedEventCount = events(first, "Target.attachedToTarget").length;

    deliver(firstCdp, { id: 2, method: "Target.getTargets" });
    await flush();

    expect(extension.socket.frames().filter((frame) => frame.type === "attach")).toHaveLength(2);
    expect(response(first, 2)?.error).toBeUndefined();
    expect(events(first, "Target.attachedToTarget")).toHaveLength(firstAttachedEventCount);
  });

  it("does not project a mixed target list when identity repair fails", async () => {
    const bridge = createBridge();
    const extension = wireExtension(bridge, (message) =>
      message.type === "attach" && message.tabId === 2
        ? { type: "error", seq: message.seq, message: "tab became unavailable" }
        : replyFor(message),
    );
    sendHello(extension.handlers);
    const { client, cdp } = await attachClient(bridge);
    deliver(cdp, { id: 2, method: "Target.setAutoAttach", params: { autoAttach: false } });
    deliver(extension.handlers, {
      type: "tabs",
      tabs: [
        { tabId: 1, url: "https://one.example", title: "One", active: true },
        { tabId: 2, url: "https://two.example", title: "Two", active: false },
      ],
    });
    await flush();

    deliver(cdp, { id: 3, method: "Target.getTargets" });
    await flush();

    expect(response(client, 3)).toMatchObject({
      error: { message: expect.stringMatching(/target identit.*unavailable/i) },
    });
  });

  it("skips a permanent Chrome refusal but retries that tab on the next enumeration", async () => {
    const bridge = createBridge();
    let refused = true;
    const extension = wireExtension(bridge, (message) =>
      message.type === "attach" && message.tabId === 2 && refused
        ? { type: "error", seq: message.seq, message: "The extensions gallery cannot be scripted." }
        : replyFor(message),
    );
    sendHello(extension.handlers, [
      { tabId: 1, url: "https://example.com", title: "Example", active: true },
      {
        tabId: 2,
        url: "https://chromewebstore.google.com/detail/x/abc",
        title: "Chrome Web Store",
        active: false,
      },
    ]);
    const client = new FakeSocket();
    const cdp = bridge.attachCdpClientSocket(client);
    deliver(cdp, { id: 1, method: "Target.getTargets" });
    await flush();
    expect(response(client, 1)).toMatchObject({
      result: { targetInfos: [expect.objectContaining({ targetId: "target-1" })] },
    });

    refused = false;
    deliver(cdp, { id: 2, method: "Target.getTargets" });
    await flush();
    expect(response(client, 2)).toMatchObject({
      result: {
        targetInfos: [
          expect.objectContaining({ targetId: "target-1" }),
          expect.objectContaining({ targetId: "target-2" }),
        ],
      },
    });
  });
});

it.each(["attach", "createTab"])(
  "does not acknowledge close before a pending %s and its native detach finish",
  async (operation) => {
    const bridge = createBridge();
    const extensionSocket = new FakeSocket();
    const extension = bridge.attachExtensionSocket(extensionSocket);
    sendHello(extension, operation === "attach" ? defaultTabs() : []);
    const clientSocket = new FakeSocket();
    const client = bridge.attachCdpClientSocket(clientSocket);
    deliver(client, {
      id: 1,
      method: operation === "attach" ? "Target.setAutoAttach" : "Target.createTarget",
      params: operation === "attach" ? { autoAttach: true } : { url: "about:blank" },
    });
    const command = extensionSocket.frames().find((frame) => frame.type === operation);
    expect(command).toBeDefined();
    let finished = false;
    const closing = client.onClose().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(false);
    deliver(extension, {
      type: "result",
      seq: command?.seq,
      result: { tabId: 1, targetId: "target-1" },
    });
    await vi.waitFor(() =>
      expect(extensionSocket.frames().some((frame) => frame.type === "detach")).toBe(true),
    );
    expect(finished).toBe(false);
    const detach = extensionSocket.frames().find((frame) => frame.type === "detach");
    deliver(extension, { type: "result", seq: detach?.seq, result: {} });
    await closing;
    expect(finished).toBe(true);
    expect(clientSocket.frames()).toEqual([]);
  },
);
