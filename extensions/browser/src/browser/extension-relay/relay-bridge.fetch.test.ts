import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import {
  flush,
  FakeSocket,
  replyFor,
  defaultTabs,
  sendHello,
  wireExtension,
} from "./relay-bridge.test-support.js";

function connectRelayClient(bridge: ExtensionRelayBridge) {
  const socket = new FakeSocket();
  const handlers = bridge.attachCdpClientSocket(socket);
  let nextId = 1;
  const send = (method: string, sessionId?: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    handlers.onMessage(JSON.stringify({ id, method, sessionId, params }));
    return id;
  };
  const response = (id: number) => socket.frames().find((frame) => frame.id === id);
  return {
    socket,
    send,
    response,
    close: handlers.onClose,
    async request(method: string, sessionId?: string, params?: Record<string, unknown>) {
      const id = send(method, sessionId, params);
      await flush();
      return response(id);
    },
  };
}

type RelayClient = ReturnType<typeof connectRelayClient>;

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

function fetchEvents(client: RelayClient, sessionId?: string) {
  return client.socket
    .frames()
    .filter(
      (frame) =>
        (frame.method === "Fetch.requestPaused" || frame.method === "Fetch.authRequired") &&
        (sessionId === undefined || frame.sessionId === sessionId),
    );
}

function pausedRequestId(client: RelayClient, sessionId: string): string {
  const params = fetchEvents(client, sessionId).at(-1)?.params;
  expect(params).toMatchObject({ requestId: expect.any(String) });
  return (params as { requestId: string }).requestId;
}

const ownershipError = { error: { code: expect.any(Number), message: expect.any(String) } };
const success = { result: {} };

describe("ExtensionRelayBridge Fetch ownership", () => {
  let bridge: ExtensionRelayBridge;
  let extension: ReturnType<typeof wireExtension>;
  let reply: typeof replyFor;
  let owner: RelayClient;
  let observer: RelayClient;
  let sessionId: string;
  let observerSessionId: string;

  beforeEach(async () => {
    bridge = new ExtensionRelayBridge();
    reply = replyFor;
    extension = wireExtension(bridge, (message) => reply(message));
    sendHello(extension.handlers, [
      ...defaultTabs(),
      { tabId: 2, url: "https://other.example", title: "Other", active: false },
    ]);
    owner = connectRelayClient(bridge);
    observer = connectRelayClient(bridge);
    await Promise.all(
      [owner, observer].map((client) =>
        client.request("Target.setAutoAttach", undefined, { autoAttach: true, flatten: true }),
      ),
    );
    sessionId = rootSession(owner);
    observerSessionId = rootSession(observer);
  });

  afterEach(async () => {
    bridge.dispose();
    await flush();
  });

  function emitPaused(
    requestId: string,
    scope: { tabId: number; sessionId?: string } = { tabId: 1 },
    method = "Fetch.requestPaused",
    extra: Record<string, unknown> = {},
  ) {
    extension.handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        ...scope,
        method,
        params: {
          requestId,
          ...extra,
          request: { url: "https://example.com/blocked", method: "GET", headers: {} },
          frameId: "frame-1",
          resourceType: "Document",
          ...(method === "Fetch.authRequired"
            ? { authChallenge: { origin: "https://example.com", scheme: "basic", realm: "test" } }
            : {}),
        },
      }),
    );
  }

  function frames(type: string, tabId?: number) {
    return extension.socket
      .frames()
      .filter((frame) => frame.type === type && (tabId === undefined || frame.tabId === tabId));
  }

  function fetchCommands(method?: string) {
    return frames("cdp").filter((frame) =>
      method ? frame.method === method : String(frame.method).startsWith("Fetch."),
    );
  }

  function acknowledge(frame: Record<string, unknown> | undefined, source = extension) {
    expect(frame).toMatchObject({ seq: expect.any(Number) });
    source.handlers.onMessage(JSON.stringify({ type: "result", seq: frame?.seq, result: {} }));
  }

  function hold(...commands: string[]) {
    reply = (message) =>
      commands.includes(message.type === "cdp" ? message.method : message.type)
        ? null
        : replyFor(message);
  }

  async function attachChild() {
    for (const client of [owner, observer]) {
      await client.request("Target.setAutoAttach", rootSession(client), {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    }
    extension.handlers.onMessage(
      JSON.stringify({
        type: "cdpEvent",
        tabId: 1,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child",
          targetInfo: { targetId: "child-target", type: "iframe" },
          waitingForDebugger: false,
        },
      }),
    );
    return {
      ownerChild: rootSession(owner, "child-target"),
      observerChild: rootSession(observer, "child-target"),
    };
  }

  it("delivers auth challenges only to their owner and rejects another client's guessed ID", async () => {
    expect(
      await owner.request("Fetch.enable", sessionId, { handleAuthRequests: true }),
    ).toMatchObject(success);
    emitPaused("physical-request", { tabId: 1 }, "Fetch.authRequired");
    const requestId = pausedRequestId(owner, sessionId);

    expect.soft(fetchEvents(observer)).toEqual([]);
    const params = { authChallengeResponse: { response: "CancelAuth" } };
    const resolution = { ...params, requestId };
    expect
      .soft(await observer.request("Fetch.continueWithAuth", observerSessionId, resolution))
      .toMatchObject(ownershipError);
    expect.soft(fetchCommands("Fetch.continueWithAuth")).toEqual([]);

    expect(await owner.request("Fetch.continueWithAuth", sessionId, resolution)).toMatchObject(
      success,
    );
    expect.soft(fetchCommands("Fetch.continueWithAuth")).toEqual([
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
    expect(await owner.request("Fetch.enable", ownerSession)).toMatchObject(success);
    emitPaused("alias-request");
    const requestId = pausedRequestId(owner, ownerSession);

    expect.soft(fetchEvents(owner, sessionId)).toEqual([]);
    expect
      .soft(await owner.request("Fetch.continueRequest", sessionId, { requestId }))
      .toMatchObject(ownershipError);
    await owner.request("Fetch.disable", sessionId);
    expect.soft(fetchCommands("Fetch.disable")).toEqual([]);
    expect.soft(await owner.request("Fetch.enable", sessionId)).toMatchObject(ownershipError);
    expect(await owner.request("Fetch.continueRequest", ownerSession, { requestId })).toMatchObject(
      success,
    );
  });

  it("fails the closing owner's pending request before disabling, then releases the scope to a connected client", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject(success);
    emitPaused("abandoned-request");
    pausedRequestId(owner, sessionId);
    hold("Fetch.failRequest");
    const closing = owner.close();
    await flush();

    const cleanup = fetchCommands("Fetch.failRequest")[0];
    expect.soft(cleanup).toMatchObject({ tabId: 1, params: { requestId: "abandoned-request" } });
    expect.soft(fetchCommands("Fetch.disable")).toEqual([]);
    expect(await observer.request("Page.getFrameTree", observerSessionId)).toMatchObject(success);
    if (cleanup) {
      acknowledge(cleanup);
    }
    await closing;
    await flush();

    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.failRequest", "Fetch.disable"]);
    expect(frames("detach")).toEqual([]);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject(success);
    emitPaused("successor-request");
    expect(fetchEvents(observer, observerSessionId).at(-1)).toMatchObject({
      params: { requestId: expect.any(String) },
    });
  });

  it("retires the physical scope when owner-close cleanup is completion-ambiguous", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject(success);
    emitPaused("abandoned-request");
    pausedRequestId(owner, sessionId);
    reply = (message) =>
      message.type === "cdp" && message.method === "Fetch.failRequest"
        ? { type: "error", seq: message.seq, message: "cleanup completion unknown" }
        : replyFor(message);
    await expect(owner.close()).rejects.toThrow("Fetch owner cleanup failed");
    await flush();
    await flush();

    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.failRequest"]);
    expect.soft(frames("detach")).toEqual([expect.objectContaining({ tabId: 1 })]);
    expect(observer.socket.closed).toBe(false);
    expect(await observer.request("Page.getFrameTree", observerSessionId)).toMatchObject(
      ownershipError,
    );
  });

  it("rejects a stale request ID after disable and successor enable without disturbing the new request", async () => {
    expect(await owner.request("Fetch.enable", sessionId)).toMatchObject(success);
    emitPaused("old-request");
    const staleId = pausedRequestId(owner, sessionId);
    expect(await owner.request("Fetch.disable", sessionId)).toMatchObject(success);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject(success);
    emitPaused("new-request");
    const currentId = pausedRequestId(observer, observerSessionId);
    const beforeResolution = fetchCommands().length;

    expect
      .soft(
        await observer.request("Fetch.continueRequest", observerSessionId, { requestId: staleId }),
      )
      .toMatchObject(ownershipError);
    expect.soft(fetchCommands()).toHaveLength(beforeResolution);
    expect(
      await observer.request("Fetch.continueRequest", observerSessionId, { requestId: currentId }),
    ).toMatchObject(success);
    expect(fetchCommands().at(-1)).toMatchObject({ params: { requestId: "new-request" } });
  });

  it("owns child Fetch independently of the root physical scope", async () => {
    const { ownerChild, observerChild } = await attachChild();
    expect(await owner.request("Fetch.enable", ownerChild)).toMatchObject(success);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject(success);
    emitPaused("child-request", { tabId: 1, sessionId: "child" });
    const requestId = pausedRequestId(owner, ownerChild);

    expect.soft(fetchEvents(observer, observerChild)).toEqual([]);
    expect
      .soft(await observer.request("Fetch.continueRequest", observerChild, { requestId }))
      .toMatchObject(ownershipError);
    expect(await owner.request("Fetch.continueRequest", ownerChild, { requestId })).toMatchObject(
      success,
    );
    expect(fetchCommands().at(-1)).toMatchObject({
      tabId: 1,
      sessionId: "child",
      params: { requestId: "child-request" },
    });
  });

  it("cleans up a successful enable reply that arrives after its client closes", async () => {
    hold("Fetch.enable");
    const enabling = owner.send("Fetch.enable", sessionId);
    await flush();
    const heldEnable = fetchCommands("Fetch.enable")[0];
    expect(heldEnable).toMatchObject({ method: "Fetch.enable", tabId: 1 });
    const closing = owner.close();
    reply = replyFor;
    acknowledge(heldEnable);
    await closing;
    await flush();

    expect(owner.response(enabling)).toBeUndefined();
    expect
      .soft(fetchCommands().map((frame) => frame.method))
      .toEqual(["Fetch.enable", "Fetch.disable"]);
    expect(await observer.request("Fetch.enable", observerSessionId)).toMatchObject(success);
    emitPaused("after-closed-enable");
    expect(fetchEvents(observer, observerSessionId)).toHaveLength(1);
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
        expect(await observer.request(method, observerSessionId, { handle: raw })).toMatchObject(
          ownershipError,
        );
      }
    }
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.method === "IO.read" || frame.method === "IO.close"),
    ).toEqual([]);
    expect(await owner.request("IO.read", sessionId, { handle })).toMatchObject(success);
    expect(
      await observer.request("IO.read", observerSessionId, { handle: "unrelated-domain" }),
    ).toMatchObject(success);
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.method === "IO.read")
        .map((frame) => frame.params),
    ).toEqual([{ handle: "native-stream" }, { handle: "unrelated-domain" }]);
    expect(owner.socket.closed).toBe(false);
    expect(observer.socket.closed).toBe(false);
  });

  it("retires the native root of an uncertain child without disturbing another tab", async () => {
    const { ownerChild } = await attachChild();
    reply = (message) =>
      message.type === "cdp" && message.sessionId === "child" && message.method === "Fetch.enable"
        ? { type: "error", seq: message.seq, message: "native completion unknown" }
        : replyFor(message);
    expect(await owner.request("Fetch.enable", ownerChild)).toMatchObject(ownershipError);
    await flush();
    expect(frames("detach")).toEqual([expect.objectContaining({ tabId: 1 })]);
    expect(await observer.request("Runtime.enable", observerSessionId)).toMatchObject(
      ownershipError,
    );
    expect(
      await observer.request("Page.getFrameTree", rootSession(observer, "target-2")),
    ).toMatchObject(success);
    expect(owner.socket.closed).toBe(false);
    expect(observer.socket.closed).toBe(false);
  });

  it("fences admission immediately and waits for cleanup and native detach before successor attach", async () => {
    await owner.request("Fetch.enable", sessionId);
    emitPaused("observed");
    await observer.request("Target.detachFromTarget", undefined, { sessionId: observerSessionId });
    hold("Fetch.failRequest", "detach");
    const closing = owner.send("Target.detachFromTarget", undefined, { sessionId });
    await flush();
    const attaching = observer.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    await flush();
    expect(await owner.request("Page.getFrameTree", sessionId)).toMatchObject(ownershipError);
    expect(observer.response(attaching)).toBeUndefined();
    expect(frames("attach", 1)).toHaveLength(1);
    acknowledge(fetchCommands("Fetch.failRequest")[0]);
    await flush();
    expect(observer.response(attaching)).toBeUndefined();
    reply = replyFor;
    acknowledge(frames("detach", 1)[0]);
    await flush();
    expect(owner.response(closing)).toMatchObject(success);
    const replacement = sessionFrom(observer.response(attaching)?.result);
    expect(replacement).not.toBe(sessionId);
    expect(await observer.request("Runtime.enable", replacement)).toMatchObject(success);
    expect(fetchCommands("Fetch.disable")).toEqual([]);
  });

  it.each(["last logical session", "owner with a live sibling"])(
    "bounds retirement of a hung body read and evaluation for %s",
    async (ending) => {
      await owner.request("Fetch.enable", sessionId);
      emitPaused("body", { tabId: 1 }, "Fetch.requestPaused", { responseStatusCode: 200 });
      const requestId = pausedRequestId(owner, sessionId);
      if (ending === "last logical session") {
        await observer.request("Target.detachFromTarget", undefined, {
          sessionId: observerSessionId,
        });
      }
      hold("Fetch.getResponseBody", "Runtime.evaluate", "Fetch.failRequest");
      const body = owner.send("Fetch.getResponseBody", sessionId, { requestId });
      const evaluation = owner.send("Runtime.evaluate", sessionId);
      await flush();
      emitPaused("known-request");
      vi.useFakeTimers();
      try {
        owner.send("Target.detachFromTarget", undefined, { sessionId });
        await vi.advanceTimersByTimeAsync(2001);
        expect(frames("detach", 1)).toHaveLength(1);
        expect(owner.response(body)).toMatchObject(ownershipError);
        expect(owner.response(evaluation)).toMatchObject(ownershipError);
        expect(fetchCommands("Fetch.failRequest")).toEqual([
          expect.objectContaining({
            params: { requestId: "known-request", errorReason: "Aborted" },
          }),
        ]);
        expect(fetchCommands("Fetch.disable")).toEqual([]);
        expect(owner.socket.closed).toBe(false);
        expect(observer.socket.closed).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("disposes held cleanup on extension loss without sending through its successor", async () => {
    await owner.request("Fetch.enable", sessionId);
    emitPaused("observed");
    await observer.request("Target.detachFromTarget", undefined, { sessionId: observerSessionId });
    hold("Fetch.failRequest");
    owner.send("Target.detachFromTarget", undefined, { sessionId });
    await flush();
    const reattaching = observer.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    await flush();
    expect(observer.response(reattaching)).toBeUndefined();
    const previous = extension;
    extension = wireExtension(bridge);
    sendHello(extension.handlers, defaultTabs());
    await flush();
    const cleanup = previous.socket.frames().find((frame) => frame.method === "Fetch.failRequest")!;
    acknowledge(cleanup, previous);
    await flush();
    expect(observer.response(reattaching)).toMatchObject(ownershipError);
    expect(
      extension.socket
        .frames()
        .filter((frame) => frame.type === "detach" || String(frame.method).startsWith("Fetch.")),
    ).toEqual([]);
  });
});
