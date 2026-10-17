import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
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

function frames(socket: FakeSocket, type: string) {
  return socket.frames().filter((frame) => frame.type === type);
}

const attached = (socket: FakeSocket) => events(socket, "Target.attachedToTarget");

function deliver(receiver: { onMessage(raw: string): void }, message: unknown) {
  receiver.onMessage(JSON.stringify(message));
}

function connectClient(bridge: ExtensionRelayBridge) {
  const client = new FakeSocket();
  return { client, cdp: bridge.attachCdpClientSocket(client) };
}

function sendCommand(
  cdp: { onMessage(raw: string): void },
  id: number,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: unknown,
) {
  deliver(cdp, { id, method, params, sessionId });
}

async function dispatch(...args: Parameters<typeof sendCommand>) {
  sendCommand(...args);
  await flush();
}

function sendResult(receiver: { onMessage(raw: string): void }, seq: unknown, result: unknown) {
  deliver(receiver, { type: "result", seq, result });
}

function readyBridge(reply?: Parameters<typeof wireExtension>[1], tabs = defaultTabs()) {
  const bridge = createBridge();
  const extension = wireExtension(bridge, reply);
  sendHello(extension.handlers, tabs);
  return { bridge, ...extension };
}

function candidate(bridge: ExtensionRelayBridge) {
  const socket = new FakeSocket();
  return { socket, handlers: bridge.attachExtensionSocket(socket) };
}

function candidateHello(
  receiver: { onMessage(raw: string): void },
  userAgent: string,
  browserVersion: string,
  tabs?: ReturnType<typeof defaultTabs>,
) {
  deliver(receiver, {
    type: "hello",
    userAgent,
    browserVersion,
    extensionVersion: "2.0.0",
    ...(tabs === undefined ? {} : { tabs }),
  });
}

function targetInfos(...ids: string[]) {
  return { result: { targetInfos: ids.map((targetId) => expect.objectContaining({ targetId })) } };
}

function tab(tabId: number, url: string, title = "Example") {
  return { tabId, url, title, active: tabId === 1 };
}

function closedSocket(closeCode: number, closeReason: string) {
  return { closed: true, closeCode, closeReason };
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
  const { client, cdp } = connectClient(bridge);
  await dispatch(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  return { client, cdp };
}

async function attachClients(bridge: ExtensionRelayBridge) {
  const first = connectClient(bridge);
  const second = connectClient(bridge);
  for (const { cdp } of [first, second]) {
    sendCommand(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  }
  await flush();
  return { first: first.client, firstCdp: first.cdp, second: second.client, secondCdp: second.cdp };
}

async function holdCdpCommand(method: string, params: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const bridge = createBridge();
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
  const { client, cdp } = connectClient(bridge);
  sendCommand(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  await vi.advanceTimersByTimeAsync(0);
  const sessionId = asOptionalRecord(
    client.frames().find((frame) => frame.method === "Target.attachedToTarget")?.params,
  )?.sessionId;
  sendCommand(cdp, 2, method, params, sessionId);
  return { bridge, extension, client, cdp, sessionId };
}

it.each(["Runtime.evaluate", "Runtime.awaitPromise"])(
  "awaits %s beyond ordinary deadline",
  async (method) => {
    const { extension, client } = await holdCdpCommand(method, { awaitPromise: true });
    await vi.advanceTimersByTimeAsync(17_000);
    expect(response(client, 2)).toBeUndefined();
    const command = events(extension.socket, method).find((frame) => frame.type === "cdp");
    sendResult(extension.handlers, command?.seq, { result: { value: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(response(client, 2)).toMatchObject({ result: { result: { value: true } } });
  },
);

it.each([
  { kind: "ordinary", method: "Runtime.evaluate", wait: 0, deadline: 15_000 },
  { kind: "awaited", method: "Runtime.callFunctionOn", wait: 120_000, deadline: 5_000 },
])("bounds $kind Runtime commands at their deadline", async ({ method, wait, deadline }) => {
  const { bridge, client } = await holdCdpCommand(method, wait ? { awaitPromise: true } : {});
  if (wait) {
    await vi.advanceTimersByTimeAsync(wait);
    expect(response(client, 2)).toBeUndefined();
  }
  await vi.advanceTimersByTimeAsync(deadline);
  expect(response(client, 2)).toMatchObject({
    error: { message: "extension relay command timed out: cdp" },
  });
  expect(bridge.extensionConnected).toBe(true);
});

it.each(["detach", "heartbeat"])("retires awaited Runtime work on %s", async (loss) => {
  const { bridge, client, extension, cdp, sessionId } = await holdCdpCommand(
    "Runtime.callFunctionOn",
    {
      awaitPromise: true,
    },
  );
  await vi.advanceTimersByTimeAsync(17_000);
  expect(response(client, 2)).toBeUndefined();
  if (loss === "detach") {
    sendCommand(cdp, 3, "Target.detachFromTarget", { sessionId });
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
  deliver(pending.handlers, { type: "tabs", tabs: defaultTabs });
  await vi.advanceTimersByTimeAsync(100);
  expect(ready).toBe(false);
  expect(pending.socket).toMatchObject(closedSocket(4001, "expected valid hello"));
  expect([bridge.extensionConnected, bridge.accessibleTabs()]).toEqual([false, []]);
  const replacement = wireExtension(bridge);
  sendHello(replacement.handlers);
  await connected;
  expect([ready, bridge.extensionConnected]).toEqual([true, true]);
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
  expect([replacement.socket.closed, bridge.extensionConnected]).toEqual([false, true]);
  await vi.advanceTimersByTimeAsync(1);
  expect(replacement.socket).toMatchObject(closedSocket(4000, "extension heartbeat timeout"));
  expect(bridge.extensionConnected).toBe(false);
});

it.each([false, true])("creates a grouped target with explicit focus=%s", async (focus) => {
  const { bridge, socket } = readyBridge();
  const { client, cdp } = focus ? connectClient(bridge) : await attachClient(bridge);
  const params = { url: "https://new.test", ...(focus ? { focus } : {}) };
  await dispatch(cdp, 2, "Target.createTarget", params);
  expect(response(client, 2)?.result).toMatchObject({ targetId: "target-999" });
  expect(frames(socket, "createTab")[0]).toMatchObject({
    url: params.url,
    background: !focus,
    focus,
  });
});

it("does not auto-attach a foreign extension page", async () => {
  const { bridge, socket } = readyBridge(undefined, [
    ...defaultTabs(),
    tab(2, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html", "Other extension"),
  ]);
  const { client } = await attachClient(bridge);
  expect(frames(socket, "attach")).toEqual([expect.objectContaining({ tabId: 1 })]);
  expect(attached(client)[0]).toMatchObject({ params: { targetInfo: { targetId: "target-1" } } });
});

it("announces initial targets before acknowledging auto-attach", async () => {
  let attach: Extract<RelayToExtensionMessage, { type: "attach" }> | undefined;
  const { bridge, handlers } = readyBridge((message) => {
    if (message.type === "attach") {
      attach = message;
      return null;
    }
    return replyFor(message);
  });
  const { client, cdp } = connectClient(bridge);
  await dispatch(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  expect(attach).toBeDefined();
  expect(response(client, 1)).toBeUndefined();
  sendResult(handlers, attach?.seq, { targetId: "target-1" });
  await flush();
  expect(client.frames()).toEqual([
    expect.objectContaining({
      method: "Target.attachedToTarget",
      params: expect.objectContaining({
        targetInfo: expect.objectContaining({ targetId: "target-1" }),
      }),
    }),
    { id: 1, result: {} },
  ]);
});

it.each(["active", "replaced extension"])("binds atomic creation to %s", async (lifecycle) => {
  const bridge = createBridge();
  const { socket, handlers: extension } = candidate(bridge);
  sendHello(extension, []);
  const { client, cdp } = connectClient(bridge);
  sendCommand(cdp, 1, "Target.createTarget", { url: "" });
  const command = socket.frames().at(-1);
  expect(command).toMatchObject({ type: "createTab", url: "about:blank" });
  sendResult(extension, command?.seq, { tabId: 99, targetId: "created-target" });
  // Resolve the old promise, then replace its owner before its continuation.
  if (lifecycle === "replaced extension") {
    sendHello(wireExtension(bridge).handlers, []);
  }
  await flush();
  expect(frames(socket, "attach")).toEqual([]);
  if (lifecycle === "active") {
    expect(client.frames().map((frame) => frame.method ?? frame.id)).toEqual([
      "Target.attachedToTarget",
      1,
    ]);
    expect(client.frames().at(-1)?.result).toEqual({ targetId: "created-target" });
  } else {
    expect(client.frames()).toEqual([]);
    expect(bridge.accessibleTabs()).toEqual([]);
    expect(frames(socket, "detach")).toEqual([]);
  }
});

it("rejects isolated browser contexts (real profile only)", async () => {
  const { bridge } = readyBridge();
  const { client, cdp } = connectClient(bridge);
  await dispatch(cdp, 1, "Target.createBrowserContext");
  const reply = response(client, 1);
  expect(reply?.error).toBeTruthy();
});

it.each([
  { name: "malformed JSON", raw: "{", id: null, error: { code: -32700, message: "Parse error" } },
  {
    name: "invalid request",
    raw: JSON.stringify({ id: 7, sessionId: "session-1", params: {} }),
    id: 7,
    sessionId: "session-1",
    error: { code: -32600, message: "Invalid request" },
  },
])("reports $name instead of leaving the client waiting", ({ name: _name, raw, ...expected }) => {
  const { client, cdp } = connectClient(createBridge());
  cdp.onMessage(raw);
  expect(client.frames()).toEqual([expected]);
});

it("keeps the active extension while a candidate is pending, malformed, or closed", () => {
  const { bridge, socket: active } = readyBridge();
  const { handlers: pending } = candidate(bridge);
  expect(active.closed).toBe(false);
  expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");
  pending.onClose();
  sendHello(pending);
  expect(bridge.extensionConnected).toBe(true);
  expect(active.closed).toBe(false);
  const { socket: malformedSocket, handlers: malformed } = candidate(bridge);
  candidateHello(malformed, "candidate", "Chrome/145.0.0.0");
  expect(malformedSocket).toMatchObject(closedSocket(4001, "expected valid hello"));
  expect(bridge.identity?.browserVersion).toBe("Chrome/144.0.0.0");
  expect(active.closed).toBe(false);
});

it("rejects an older candidate when a newer candidate promotes first", () => {
  const { bridge, socket: activeSocket, handlers: active } = readyBridge();
  const { socket: firstSocket, handlers: first } = candidate(bridge);
  const { socket: secondSocket, handlers: second } = candidate(bridge);
  expect(activeSocket.closed).toBe(false);
  candidateHello(second, "second", "Chrome/146.0.0.0", []);
  expect(activeSocket.closed).toBe(true);
  expect(firstSocket.closed).toBe(false);
  expect(secondSocket.closed).toBe(false);
  expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");
  candidateHello(first, "first", "Chrome/145.0.0.0", []);
  expect(firstSocket).toMatchObject(closedSocket(4000, "superseded by newer extension connection"));
  expect(bridge.identity?.browserVersion).toBe("Chrome/146.0.0.0");
  first.onClose();
  active.onClose();
  expect(bridge.extensionConnected).toBe(true);
  expect(secondSocket.closed).toBe(false);
});

it("answers the Puppeteer connect bootstrap without protocol errors", async () => {
  const { bridge } = readyBridge();
  const { client, cdp } = connectClient(bridge);
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

it("invalidates captured operation identity when another extension reconnects", async () => {
  const { bridge } = readyBridge();
  const cdp = bridge.attachCdpClientSocket(new FakeSocket());
  await dispatch(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  const resolveTarget = bridge.captureOperationTarget("target-1");
  const replacement = wireExtension(bridge);
  sendHello(replacement.handlers);
  await flush();
  expect(resolveTarget?.()).toBeUndefined();
  expect(bridge.captureOperationTarget("target-1")?.()).toBe("target-1");
});
it.each(["target_closed", "canceled_by_user"])("honors native %s recovery", async (reason) => {
  let targetId = "original-target";
  const { bridge, handlers, socket } = readyBridge((message) =>
    message.type === "attach"
      ? { type: "result", seq: message.seq, result: { targetId } }
      : replyFor(message),
  );
  const { first, firstCdp, second, secondCdp } = await attachClients(bridge);
  const original = attached(first)[0];
  const sessionId = (original?.params as { sessionId?: string } | undefined)?.sessionId;
  expect(typeof sessionId).toBe("string");
  await dispatch(firstCdp, 2, "Target.detachFromTarget", { sessionId });
  targetId = "replacement-target";
  deliver(handlers, { type: "detached", tabId: 1, reason });
  await flush();
  deliver(handlers, {
    type: "tabs",
    tabs: [tab(1, "https://example.com/next", "Next")],
  });
  await flush();
  const recovered = reason === "target_closed";
  expect(attached(first)).toHaveLength(1);
  const secondAttached = attached(second);
  expect(secondAttached).toHaveLength(recovered ? 2 : 1);
  expect(frames(socket, "attach")).toHaveLength(recovered ? 2 : 1);
  if (recovered) {
    expect(secondAttached[1]?.params).toMatchObject({
      sessionId: expect.not.stringMatching(`^${sessionId}$`),
      targetInfo: { targetId: "replacement-target" },
    });
  }
  await dispatch(secondCdp, 3, "Runtime.evaluate", { expression: "1" }, sessionId);
  expect(response(second, 3)?.error).toBeDefined();
  expect(events(socket, "Runtime.evaluate").filter((frame) => frame.type === "cdp")).toHaveLength(
    0,
  );
});

it.each(["client close", "tab removal", "user cancellation"])(
  "rechecks recovery on %s",
  async (ending) => {
    const recovery = createDeferred<RelayToExtensionMessage>();
    let attachAttempts = 0;
    const { bridge, handlers } = readyBridge((message) => {
      if (message.type === "attach" && ++attachAttempts > 1) {
        recovery.resolve(message);
        return null;
      }
      return replyFor(message);
    });
    const { first, firstCdp, second } = await attachClients(bridge);
    deliver(handlers, { type: "detached", tabId: 1, reason: "target_closed" });
    const pending = await recovery.promise;
    const closing = ending === "client close" ? firstCdp.onClose() : Promise.resolve();
    if (ending === "tab removal") {
      deliver(handlers, { type: "tabs", tabs: [] });
    } else if (ending === "user cancellation") {
      deliver(handlers, { type: "detached", tabId: 1, reason: "canceled_by_user" });
    }
    deliver(handlers, replyFor(pending));
    await closing;
    await flush();
    expect(attached(first)).toHaveLength(1);
    expect(attached(second)).toHaveLength(ending === "client close" ? 2 : 1);
    expect(attachAttempts).toBe(2);
  },
);

it("includes a tab discovered while another native attachment is pending", async () => {
  const firstAttach = createDeferred<RelayToExtensionMessage>();
  const nextStep = createDeferred<Record<string, unknown>>();
  const { bridge, handlers } = readyBridge((message) => {
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
  const client = new FakeSocket();
  const send = client.send.bind(client);
  client.send = (data) => {
    send(data);
    nextStep.resolve(JSON.parse(data));
  };
  const cdp = bridge.attachCdpClientSocket(client);
  sendCommand(cdp, 1, "Target.getTargets");
  const first = await firstAttach.promise;
  deliver(handlers, {
    type: "tabs",
    tabs: [tab(1, "https://one.example", "One"), tab(2, "https://two.example", "Two")],
  });
  deliver(handlers, replyFor(first));
  const second = await nextStep.promise;
  expect(second).toMatchObject({ type: "attach", tabId: 2 });
  sendResult(handlers, second.seq, { targetId: "target-2" });
  await flush();
  expect(response(client, 1)).toMatchObject(targetInfos("target-1", "target-2"));
});

it("repairs reconnect attach without undoing a later explicit detach", async () => {
  const bridge = createBridge();
  const { socket: initialSocket, handlers: initial } = candidate(bridge);
  sendHello(initial);
  const { client, cdp } = connectClient(bridge);
  sendCommand(cdp, 1, "Target.setAutoAttach", { autoAttach: true });
  expect(frames(initialSocket, "attach")).toHaveLength(1);
  const replacement = wireExtension(bridge);
  sendHello(replacement.handlers);
  await flush();
  expect(frames(replacement.socket, "attach")).toEqual([expect.objectContaining({ tabId: 1 })]);
  await dispatch(cdp, 2, "Target.getTargets");
  expect(response(client, 2)?.result).toMatchObject(targetInfos("target-1").result);
  const { client: peer, cdp: peerCdp } = connectClient(bridge);
  await dispatch(peerCdp, 1, "Target.setAutoAttach", { autoAttach: true });
  const sessionId = (attached(client).at(-1)?.params as { sessionId?: string } | undefined)
    ?.sessionId;
  expect(typeof sessionId).toBe("string");
  await dispatch(cdp, 3, "Target.detachFromTarget", { sessionId });
  const attachedEventCount = attached(client).length;
  const peerAttachedEventCount = attached(peer).length;
  const afterDetach = wireExtension(bridge);
  sendHello(afterDetach.handlers, [tab(1, "https://example.com", "Updated")]);
  await flush();
  expect(frames(afterDetach.socket, "attach")).toHaveLength(1);
  expect(attached(client)).toHaveLength(attachedEventCount);
  expect(attached(peer)).toHaveLength(peerAttachedEventCount + 1);
  await dispatch(cdp, 4, "Target.getTargets");
  expect(frames(afterDetach.socket, "attach")).toHaveLength(1);
  expect(response(client, 4)?.result).toMatchObject({
    targetInfos: [expect.objectContaining({ targetId: "target-1", attached: true })],
  });
  expect(attached(client)).toHaveLength(attachedEventCount);
  deliver(afterDetach.handlers, { type: "tabs", tabs: [] });
  deliver(afterDetach.handlers, {
    type: "tabs",
    tabs: [tab(1, "https://reused.example", "Reused")],
  });
  await flush();
  expect(attached(client)).toHaveLength(attachedEventCount + 1);
});

it("does not project a disconnected zero-tab extension as authoritative empty", async () => {
  const { bridge, handlers } = readyBridge(undefined, []);
  handlers.onClose();
  const { client, cdp } = connectClient(bridge);
  await dispatch(cdp, 1, "Target.getTargets");
  expect(response(client, 1)).toMatchObject({
    error: { message: expect.stringMatching(/extension.*disconnected/i) },
  });
});

it("rejects discovery when the previous native retirement fails", async () => {
  const retirement = createDeferred<Extract<RelayToExtensionMessage, { type: "detach" }>>();
  const { bridge, handlers } = readyBridge((message) => {
    if (message.type === "detach") {
      retirement.resolve(message);
      return null;
    }
    return replyFor(message);
  });
  const { client, cdp } = connectClient(bridge);
  sendCommand(cdp, 1, "Target.getTargets");
  const detach = await retirement.promise;
  sendCommand(cdp, 2, "Target.getTargets");
  deliver(handlers, {
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
  let attachAttempts = 0;
  const { bridge, socket } = readyBridge((message) => {
    if (message.type === "attach" && attachAttempts++ === 0) {
      return { type: "error", seq: message.seq, message: "first client lost its claim" };
    }
    return replyFor(message);
  });
  const { client: first, cdp: firstCdp } = await attachClient(bridge);
  const { client: second } = await attachClient(bridge);
  expect(attached(second).length > 0).toBe(true);
  expect(attached(first).length > 0).toBe(true);
  const firstAttachedEventCount = attached(first).length;
  await dispatch(firstCdp, 2, "Target.getTargets");
  expect(frames(socket, "attach")).toHaveLength(2);
  expect(response(first, 2)?.error).toBeUndefined();
  expect(attached(first)).toHaveLength(firstAttachedEventCount);
});

it("skips a permanent Chrome refusal but retries that tab on the next enumeration", async () => {
  let refused = true;
  const { bridge } = readyBridge(
    (message) =>
      message.type === "attach" && message.tabId === 2 && refused
        ? {
            type: "error",
            seq: message.seq,
            message: "The extensions gallery cannot be scripted.",
          }
        : replyFor(message),
    [
      ...defaultTabs(),
      tab(2, "https://chromewebstore.google.com/detail/x/abc", "Chrome Web Store"),
    ],
  );
  const { client, cdp } = connectClient(bridge);
  await dispatch(cdp, 1, "Target.getTargets");
  expect(response(client, 1)).toMatchObject(targetInfos("target-1"));
  refused = false;
  await dispatch(cdp, 2, "Target.getTargets");
  expect(response(client, 2)).toMatchObject(targetInfos("target-1", "target-2"));
});
it.each(["attach", "createTab"])(
  "waits for %s and native detach before closing",
  async (operation) => {
    const bridge = createBridge();
    const { socket: extensionSocket, handlers: extension } = candidate(bridge);
    sendHello(extension, operation === "attach" ? defaultTabs() : []);
    const { client: clientSocket, cdp: client } = connectClient(bridge);
    sendCommand(
      client,
      1,
      operation === "attach" ? "Target.setAutoAttach" : "Target.createTarget",
      operation === "attach" ? { autoAttach: true } : { url: "about:blank" },
    );
    const command = frames(extensionSocket, operation)[0];
    expect(command).toBeDefined();
    let finished = false;
    const closing = client.onClose().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(false);
    sendResult(extension, command?.seq, { tabId: 1, targetId: "target-1" });
    await vi.waitFor(() => expect(frames(extensionSocket, "detach").length > 0).toBe(true));
    expect(finished).toBe(false);
    const detach = frames(extensionSocket, "detach")[0];
    sendResult(extension, detach?.seq, {});
    await closing;
    expect(finished).toBe(true);
    expect(clientSocket.frames()).toEqual([]);
  },
);
