import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  flush,
  replyFor,
  defaultTabs,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";
import { createRelayClient } from "./relay-runtime.test-support.js";

type RelayClient = ReturnType<typeof createRelayClient>;

function sessionFrom(value: unknown): string {
  expect(value).toMatchObject({ sessionId: expect.any(String) });
  return (value as { sessionId: string }).sessionId;
}

function rootSession(client: RelayClient, targetId = "target-1"): string {
  const attached = client.socket.frames().find((frame) => {
    const params = frame.params as { targetInfo?: { targetId?: string } } | undefined;
    return frame.method === "Target.attachedToTarget" && params?.targetInfo?.targetId === targetId;
  });
  return sessionFrom(attached?.params);
}

function pauses(client: RelayClient, sessionId?: string) {
  return client.socket
    .frames()
    .filter(
      (frame) =>
        (frame.method === "Fetch.requestPaused" || frame.method === "Fetch.authRequired") &&
        (sessionId === undefined || frame.sessionId === sessionId),
    );
}

function pausedRequestId(client: RelayClient, sessionId: string): string {
  const params = pauses(client, sessionId).at(-1)?.params;
  expect(params).toMatchObject({ requestId: expect.any(String) });
  return (params as { requestId: string }).requestId;
}

const denied = { error: { code: expect.any(Number), message: expect.any(String) } };
const success = { result: {} };
const autoAttach = { autoAttach: true, flatten: true };

async function check(
  client: RelayClient,
  method: string,
  sessionId: string,
  params?: Record<string, unknown>,
  expected: object = success,
) {
  expect(await client.request(method, sessionId, params)).toMatchObject(expected);
}

let bridge: ExtensionRelayBridge;
let extension: ReturnType<typeof wireExtension>;
let reply: typeof replyFor;
let owner: RelayClient;
let observer: RelayClient;
let sessionId: string;
let peerSession: string;

beforeEach(async () => {
  bridge = new ExtensionRelayBridge();
  reply = replyFor;
  extension = wireExtension(bridge, (message) => reply(message));
  sendHello(extension.handlers, [
    ...defaultTabs(),
    { tabId: 2, url: "https://other.example", title: "Other", active: false },
  ]);
  owner = createRelayClient(bridge);
  observer = createRelayClient(bridge);
  await Promise.all(
    [owner, observer].map((client) =>
      client.request("Target.setAutoAttach", undefined, autoAttach),
    ),
  );
  sessionId = rootSession(owner);
  peerSession = rootSession(observer);
});

afterEach(async () => {
  vi.useRealTimers();
  bridge.dispose();
  await flush();
});

function emitPaused(
  requestId: string,
  scope: { tabId: number; sessionId?: string } = { tabId: 1 },
  method = "Fetch.requestPaused",
  extra: Record<string, unknown> = {},
) {
  emit(method, { requestId, ...extra }, scope);
}

function emit(method: string, params: object, scope = { tabId: 1 }) {
  extension.handlers.onMessage(JSON.stringify({ type: "cdpEvent", ...scope, method, params }));
}

function frames(type: string, tabId?: number) {
  return extension.socket
    .frames()
    .filter((frame) => frame.type === type && (tabId === undefined || frame.tabId === tabId));
}

function commands(method?: string) {
  return frames("cdp").filter((frame) =>
    method ? frame.method === method : String(frame.method).startsWith("Fetch."),
  );
}

function acknowledge(frame: Record<string, unknown> | undefined, source = extension) {
  expect(frame).toMatchObject({ seq: expect.any(Number) });
  source.handlers.onMessage(JSON.stringify({ type: "result", seq: frame?.seq, result: {} }));
}

function hold(...methods: string[]) {
  reply = (message) =>
    methods.includes(message.type === "cdp" ? message.method : message.type)
      ? null
      : replyFor(message);
}

async function enablePaused(requestId: string) {
  await check(owner, "Fetch.enable", sessionId);
  emitPaused(requestId);
  return pausedRequestId(owner, sessionId);
}

function expectOpenClients() {
  expect([owner.socket.closed, observer.socket.closed]).toEqual([false, false]);
}

async function beginRetirement(...held: string[]) {
  await owner.request("Fetch.enable", sessionId);
  emitPaused("observed");
  await observer.request("Target.detachFromTarget", undefined, { sessionId: peerSession });
  hold(...held);
  const closing = owner.send("Target.detachFromTarget", undefined, { sessionId });
  await flush();
  const attaching = observer.send("Target.attachToTarget", undefined, { targetId: "target-1" });
  await flush();
  return { closing, attaching };
}

async function attachChild() {
  for (const client of [owner, observer]) {
    await client.request("Target.setAutoAttach", rootSession(client), {
      ...autoAttach,
      waitForDebuggerOnStart: true,
    });
  }
  emit("Target.attachedToTarget", {
    sessionId: "child",
    targetInfo: { targetId: "child-target", type: "iframe" },
    waitingForDebugger: false,
  });
  return {
    ownerChild: rootSession(owner, "child-target"),
    observerChild: rootSession(observer, "child-target"),
  };
}

it("delivers auth challenges only to their owner and rejects another client's guessed ID", async () => {
  await check(owner, "Fetch.enable", sessionId, { handleAuthRequests: true });
  emitPaused("physical-request", { tabId: 1 }, "Fetch.authRequired");
  const requestId = pausedRequestId(owner, sessionId);
  expect.soft(pauses(observer)).toEqual([]);
  const params = { authChallengeResponse: { response: "CancelAuth" } };
  const resolution = { ...params, requestId };
  expect
    .soft(await observer.request("Fetch.continueWithAuth", peerSession, resolution))
    .toMatchObject(denied);
  expect.soft(commands("Fetch.continueWithAuth")).toEqual([]);
  await check(owner, "Fetch.continueWithAuth", sessionId, resolution);
  expect.soft(commands("Fetch.continueWithAuth")).toEqual([
    expect.objectContaining({
      tabId: 1,
      params: { ...params, requestId: "physical-request" },
    }),
  ]);
});

it("keeps an alias Fetch owner separate from another session on the same client", async () => {
  const browser = await owner.request("Target.attachToBrowserTarget");
  const browserSession = sessionFrom(browser?.result);
  const attached = await owner.request("Target.attachToTarget", browserSession, {
    targetId: "target-1",
    flatten: true,
  });
  const ownerSession = sessionFrom(attached?.result);
  await check(owner, "Fetch.enable", ownerSession);
  emitPaused("alias-request");
  const requestId = pausedRequestId(owner, ownerSession);
  expect.soft(pauses(owner, sessionId)).toEqual([]);
  expect
    .soft(await owner.request("Fetch.continueRequest", sessionId, { requestId }))
    .toMatchObject(denied);
  await owner.request("Fetch.disable", sessionId);
  expect.soft(commands("Fetch.disable")).toEqual([]);
  expect.soft(await owner.request("Fetch.enable", sessionId)).toMatchObject(denied);
  await check(owner, "Fetch.continueRequest", ownerSession, { requestId });
});

it("fails the closing owner's pending request before disabling, then releases the scope to a connected client", async () => {
  await enablePaused("abandoned-request");
  hold("Fetch.failRequest");
  const closing = owner.close();
  await flush();
  const cleanup = commands("Fetch.failRequest")[0];
  expect.soft(cleanup).toMatchObject({ tabId: 1, params: { requestId: "abandoned-request" } });
  expect.soft(commands("Fetch.disable")).toEqual([]);
  await check(observer, "Page.getFrameTree", peerSession);
  acknowledge(cleanup);
  await closing;
  await flush();
  expect
    .soft(commands().map((frame) => frame.method))
    .toEqual(["Fetch.enable", "Fetch.failRequest", "Fetch.disable"]);
  expect(frames("detach")).toEqual([]);
  await check(observer, "Fetch.enable", peerSession);
  emitPaused("successor-request");
  pausedRequestId(observer, peerSession);
});

it("retires the physical scope when owner-close cleanup is completion-ambiguous", async () => {
  await enablePaused("abandoned-request");
  reply = (message) =>
    message.type === "cdp" && message.method === "Fetch.failRequest"
      ? { type: "error", seq: message.seq, message: "cleanup completion unknown" }
      : replyFor(message);
  await expect(owner.close()).rejects.toThrow("Fetch owner cleanup failed");
  await flush();
  await flush();
  expect
    .soft(commands().map((frame) => frame.method))
    .toEqual(["Fetch.enable", "Fetch.failRequest"]);
  expect.soft(frames("detach")).toEqual([expect.objectContaining({ tabId: 1 })]);
  expect(observer.socket.closed).toBe(false);
  await check(observer, "Page.getFrameTree", peerSession, undefined, denied);
});

it("owns child Fetch independently of the root physical scope", async () => {
  const { ownerChild, observerChild } = await attachChild();
  await check(owner, "Fetch.enable", ownerChild);
  await check(observer, "Fetch.enable", peerSession);
  emitPaused("child-request", { tabId: 1, sessionId: "child" });
  const requestId = pausedRequestId(owner, ownerChild);
  expect.soft(pauses(observer, observerChild)).toEqual([]);
  expect
    .soft(await observer.request("Fetch.continueRequest", observerChild, { requestId }))
    .toMatchObject(denied);
  await check(owner, "Fetch.continueRequest", ownerChild, { requestId });
  expect(commands().at(-1)).toMatchObject({
    tabId: 1,
    sessionId: "child",
    params: { requestId: "child-request" },
  });
});

it("cleans up a successful enable reply that arrives after its client closes", async () => {
  hold("Fetch.enable");
  const enabling = owner.send("Fetch.enable", sessionId);
  await flush();
  const heldEnable = commands("Fetch.enable")[0];
  expect(heldEnable).toMatchObject({ method: "Fetch.enable", tabId: 1 });
  const closing = owner.close();
  reply = replyFor;
  acknowledge(heldEnable);
  await closing;
  await flush();
  expect(owner.frame(enabling)).toBeUndefined();
  expect.soft(commands().map((frame) => frame.method)).toEqual(["Fetch.enable", "Fetch.disable"]);
  await check(observer, "Fetch.enable", peerSession);
  emitPaused("after-closed-enable");
  expect(pauses(observer, peerSession)).toHaveLength(1);
});

it("keeps raw and minted response streams private without intercepting unrelated IO", async () => {
  reply = (message) =>
    message.type === "cdp" && message.method === "Fetch.takeResponseBodyAsStream"
      ? { type: "result", seq: message.seq, result: { stream: "native-stream" } }
      : replyFor(message);
  await owner.request("Fetch.enable", sessionId);
  emitPaused("response", { tabId: 1 }, "Fetch.requestPaused", { responseStatusCode: 200 });
  const body = await owner.request("Fetch.takeResponseBodyAsStream", sessionId, {
    requestId: pausedRequestId(owner, sessionId),
  });
  const handle = asOptionalRecord(body?.result)?.stream;
  if (typeof handle !== "string") {
    throw new Error("Missing response stream");
  }
  for (const method of ["IO.read", "IO.close"]) {
    for (const raw of [handle, "native-stream"]) {
      expect(await observer.request(method, peerSession, { handle: raw })).toMatchObject(denied);
    }
  }
  const ioCommands = () =>
    extension.socket
      .frames()
      .filter((frame) => frame.method === "IO.read" || frame.method === "IO.close");
  expect(ioCommands()).toEqual([]);
  await check(owner, "IO.read", sessionId, { handle });
  await check(observer, "IO.read", peerSession, { handle: "unrelated-domain" });
  expect(ioCommands().map((frame) => frame.params)).toEqual([
    { handle: "native-stream" },
    { handle: "unrelated-domain" },
  ]);
  expectOpenClients();
});

it("retires the native root of an uncertain child without disturbing another tab", async () => {
  const { ownerChild } = await attachChild();
  reply = (message) =>
    message.type === "cdp" && message.sessionId === "child" && message.method === "Fetch.enable"
      ? { type: "error", seq: message.seq, message: "native completion unknown" }
      : replyFor(message);
  await check(owner, "Fetch.enable", ownerChild, undefined, denied);
  await flush();
  expect(frames("detach")).toEqual([expect.objectContaining({ tabId: 1 })]);
  await check(observer, "Runtime.enable", peerSession, undefined, denied);
  await check(observer, "Page.getFrameTree", rootSession(observer, "target-2"));
  expectOpenClients();
});

it("fences admission immediately and waits for cleanup and native detach before successor attach", async () => {
  const { closing, attaching } = await beginRetirement("Fetch.failRequest", "detach");
  await check(owner, "Page.getFrameTree", sessionId, undefined, denied);
  expect(observer.frame(attaching)).toBeUndefined();
  expect(frames("attach", 1)).toHaveLength(1);
  acknowledge(commands("Fetch.failRequest")[0]);
  await flush();
  expect(observer.frame(attaching)).toBeUndefined();
  reply = replyFor;
  acknowledge(frames("detach", 1)[0]);
  await flush();
  expect(owner.frame(closing)).toMatchObject(success);
  const replacement = sessionFrom(observer.frame(attaching)?.result);
  expect(replacement).not.toBe(sessionId);
  await check(observer, "Runtime.enable", replacement);
  expect(commands("Fetch.disable")).toEqual([]);
});

it.each(["last session", "live sibling"])(
  "bounds hung read and evaluation with %s",
  async (ending) => {
    await owner.request("Fetch.enable", sessionId);
    emitPaused("body", { tabId: 1 }, "Fetch.requestPaused", { responseStatusCode: 200 });
    const requestId = pausedRequestId(owner, sessionId);
    if (ending === "last session") {
      await observer.request("Target.detachFromTarget", undefined, { sessionId: peerSession });
    }
    hold("Fetch.getResponseBody", "Runtime.evaluate", "Fetch.failRequest");
    const body = owner.send("Fetch.getResponseBody", sessionId, { requestId });
    const evaluation = owner.send("Runtime.evaluate", sessionId);
    await flush();
    emitPaused("known-request");
    vi.useFakeTimers();
    owner.send("Target.detachFromTarget", undefined, { sessionId });
    await vi.advanceTimersByTimeAsync(2001);
    expect(frames("detach", 1)).toHaveLength(1);
    expect(owner.frame(body)).toMatchObject(denied);
    expect(owner.frame(evaluation)).toMatchObject(denied);
    expect(commands("Fetch.failRequest")).toEqual([
      expect.objectContaining({
        params: { requestId: "known-request", errorReason: "Aborted" },
      }),
    ]);
    expect(commands("Fetch.disable")).toEqual([]);
    expectOpenClients();
  },
);

it("disposes held cleanup on extension loss without sending through its successor", async () => {
  const { attaching: reattaching } = await beginRetirement("Fetch.failRequest");
  expect(observer.frame(reattaching)).toBeUndefined();
  const previous = extension;
  extension = wireExtension(bridge);
  sendHello(extension.handlers, defaultTabs());
  await flush();
  const cleanup = previous.socket.frames().find((frame) => frame.method === "Fetch.failRequest")!;
  acknowledge(cleanup, previous);
  await flush();
  expect(observer.frame(reattaching)).toMatchObject(denied);
  expect(
    extension.socket
      .frames()
      .filter((frame) => frame.type === "detach" || String(frame.method).startsWith("Fetch.")),
  ).toEqual([]);
});
