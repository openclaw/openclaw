import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeSocket, flush, sendHello, wireExtension } from "./relay-bridge.test-support.js";
import {
  runtimeContext,
  createdRuntimeContexts as contextFrames,
  expectContextBeforeResult as expectReplay,
  createRuntimeFixture,
} from "./relay-runtime.test-support.js";

type Fixture = ReturnType<typeof createRuntimeFixture>;
type Client = ReturnType<Fixture["client"]>;
async function attachedClient(f: Fixture) {
  const client = f.client();
  return { client, root: await client.attach() };
}
function childEvent(f: Fixture, targetId = "frame", sessionId = "child", parent?: string) {
  const targetInfo = { type: targetId === "worker" ? "worker" : "iframe", targetId };
  f.event("Target.attachedToTarget", { sessionId, targetInfo, waitingForDebugger: false }, parent);
}
const bindingFrames = (client: Client) => client.frames("Runtime.bindingCalled");

function expectEvent(c: Client, method: string, sessionId: string, params: unknown) {
  expect(c.socket.frames()).toContainEqual({ sessionId, method, params });
}
function expectDetached(c: Client, parent: string, sessionId: string, targetId: string) {
  expectEvent(c, "Target.detachedFromTarget", parent, { sessionId, targetId });
}
const contexts = (c: Client, root: string) =>
  contextFrames(c.socket, root).map((frame) => frame.params);
const contextIds = (c: Client, root: string) =>
  contexts(c, root).map((params) => asOptionalRecord(asOptionalRecord(params)?.context)?.id);
const expectContexts = (c: Client, root: string, ...ids: number[]) =>
  expect(contexts(c, root)).toEqual(ids.map((id) => ({ context: runtimeContext(id) })));

describe("relay logical Runtime subscriptions", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createRuntimeFixture();
  });
  const event = (message: unknown) => f.extension.handlers.onMessage(JSON.stringify(message));
  const created = (id: number, sessionId?: string) =>
    f.event("Runtime.executionContextCreated", { context: runtimeContext(id) }, sessionId);
  const attach = () => attachedClient(f);
  const binding = (c: Client, root: string, name: string, method = "Runtime.addBinding") =>
    c.request(method, root, { name });
  async function parentWithChildren(c: Client, root: string) {
    await c.autoAttach(root);
    childEvent(f);
    const child = c.child("frame", root);
    await c.autoAttach(child);
    childEvent(f, "worker", "grandchild", "child");
    return { child, grandchild: c.child("worker", child) };
  }
  async function delayedReplay() {
    const { client: peer, root: peerRoot } = await attach();
    await peer.request("Runtime.enable", peerRoot);
    const { client: c, root } = await attach();
    f.hold("Page.getFrameTree");
    c.send("Page.getFrameTree", root);
    const enable = c.send("Runtime.enable", root);
    await flush();
    return { c, root, enable };
  }
  it("orders initial Runtime after all earlier frame reads without blocking peers or other commands", async () => {
    const { client: first, root } = await attach();
    await first.request("Runtime.enable", root);
    const { client: late, root: lateRoot } = await attach();
    f.hold("Page.getFrameTree");
    const reads = [
      late.send("Page.getFrameTree", lateRoot),
      late.send("Page.getFrameTree", lateRoot),
    ];
    const enable = late.send("Runtime.enable", lateRoot);
    await flush();
    expect(f.commands("Runtime.enable")).toHaveLength(1);
    await late.request("Page.handleJavaScriptDialog", lateRoot, { accept: true });
    await late.request("Fetch.enable", lateRoot, { patterns: [{ urlPattern: "*" }] });
    f.event("Fetch.requestPaused", { requestId: "native-request" });
    const paused = late.socket.frames().find((frame) => frame.method === "Fetch.requestPaused");
    const requestId = asOptionalRecord(paused?.params)?.requestId;
    expect(requestId).toBeTypeOf("string");
    await late.request("Fetch.continueRequest", lateRoot, { requestId });
    expect(f.commands("Fetch.continueRequest").at(-1)?.params).toEqual({
      requestId: "native-request",
    });
    await first.request("Runtime.evaluate", root, { expression: "1" });
    created(3);
    f.event("Runtime.executionContextDestroyed", { executionContextId: 1 });
    f.event("Runtime.consoleAPICalled", { type: "log", args: [] });
    expectContexts(first, root, 1, 3);
    expect(first.socket.frames().at(-1)).toMatchObject({ method: "Runtime.consoleAPICalled" });
    expect(contextFrames(late.socket, lateRoot)).toEqual([]);
    const secondRead = f.commands("Page.getFrameTree")[1]!;
    event({ type: "result", seq: secondRead.seq, result: {} });
    await flush();
    expect(late.socket.frames().find((frame) => frame.id === reads[1])).toBeDefined();
    expect(f.commands("Runtime.enable")).toHaveLength(1);
    f.release();
    await flush();
    expectReplay(late.socket, lateRoot, enable, [runtimeContext(3)]);
    const frames = late.socket.frames();
    const contextIndex = frames.findIndex(
      (frame) => frame.method === "Runtime.executionContextCreated",
    );
    for (const id of reads) {
      expect(frames.slice(0, contextIndex)).toContainEqual(expect.objectContaining({ id }));
    }
    await late.request("Runtime.enable", lateRoot);
    expect(contextFrames(late.socket, lateRoot)).toHaveLength(1);
    f.hold("Page.getFrameTree");
    late.send("Page.getFrameTree", lateRoot);
    await flush();
    created(4);
    expect(contexts(late, lateRoot).at(-1)).toEqual({ context: runtimeContext(4) });
    f.release();
    await flush();
  });

  it("rechecks worker access before replay after a delayed frame-tree reply", async () => {
    const { c: late, root, enable } = await delayedReplay();
    f.revokeAccess();
    f.release();
    await flush();
    expect(late.frame(enable)?.error).toMatchObject({ message: "tab access was revoked" });
    expect(contextFrames(late.socket, root)).toEqual([]);
  });

  it.each(["disable", "detach", "revoke", "replacement", "native detach"])(
    "fences an enable waiting for frame publication after %s",
    async (ending) => {
      const { c, root, enable } = await delayedReplay();
      expect(f.commands("Runtime.enable")).toHaveLength(1);
      if (ending === "disable") {
        await c.request("Runtime.disable", root);
      } else if (ending === "detach") {
        await c.request("Target.detachFromTarget", undefined, { sessionId: root });
      } else if (ending === "revoke") {
        event({ type: "tabs", tabs: [] });
      } else if (ending === "replacement") {
        sendHello(wireExtension(f.bridge).handlers);
      } else {
        event({ type: "detached", tabId: 1, reason: "target_closed" });
      }
      f.release();
      await flush();
      expect(f.commands("Runtime.enable")).toHaveLength(1);
      expect(contextFrames(c.socket, root)).toEqual([]);
      expect(c.frame(enable)?.error).toBeDefined();
      if (ending === "disable") {
        const current = await c.request("Runtime.enable", root);
        expectReplay(c.socket, root, current.id);
      }
    },
  );

  it("never replays retired contexts after clearing", async () => {
    const method = "Runtime.executionContextsCleared";
    const { client: first, root } = await attach();
    await first.request("Runtime.enable", root);
    f.event(method, { executionContextId: 1, executionContextUniqueId: "context-1" });
    created(3);
    const { client: late, root: lateRoot } = await attach();
    const response = await late.request("Runtime.enable", lateRoot);
    expectReplay(late.socket, lateRoot, response.id, [runtimeContext(3)]);
    expectEvent(first, method, root, {
      executionContextId: 1,
      executionContextUniqueId: "context-1",
    });
  });

  it("gives explicit page attachments independent subscriptions under a browser parent", async () => {
    const { client: c, root } = await attach();
    await c.request("Runtime.enable", root);
    const parent = await c.session("Target.attachToBrowserTarget");
    const alias = await c.session("Target.attachToTarget", parent, {
      targetId: "target-1",
      flatten: true,
    });
    expect(alias).not.toBe(root);
    expectEvent(c, "Target.attachedToTarget", parent, {
      sessionId: alias,
      targetInfo: expect.objectContaining({ targetId: "target-1" }),
      waitingForDebugger: false,
    });
    expect(contextFrames(c.socket, alias)).toEqual([]);
    const enabled = await c.request("Runtime.enable", alias);
    expectReplay(c.socket, alias, enabled.id);
    await c.request("Runtime.disable", alias);
    f.event("Runtime.consoleAPICalled", { type: "log", args: [] });
    expect(c.frames("Runtime.consoleAPICalled").map((frame) => frame.sessionId)).toEqual([root]);
    await c.request("Target.detachFromTarget", parent, { sessionId: alias });
    expectDetached(c, parent, alias, "target-1");
    expect((await c.request("Runtime.enable", alias)).error).toBeDefined();
  });

  it("routes real child contexts separately and retires child routing on detach, including pending enables", async () => {
    const { client: c, root } = await attach();
    await c.request("Runtime.enable", root);
    await c.autoAttach(root);
    childEvent(f);
    const child = c.child("frame", root);
    f.hold();
    const pending = c.send("Runtime.enable", child);
    await flush();
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
    created(4, "child");
    f.release();
    await flush();
    expect(c.frame(pending)?.error).toBeDefined();
    expectContexts(c, root, 1);
    expect(contextIds(c, child)).not.toContain(4);
    expect((await c.request("Runtime.enable", child)).error).toBeDefined();
  });

  it("keeps child Runtime subscriptions independent and routes detach to their alias parent", async () => {
    const { client: first, root } = await attach();
    const second = f.client();
    const secondRoot = await second.session("Target.attachToTarget", undefined, {
      targetId: "target-1",
      flatten: true,
    });
    await first.autoAttach(root);
    await second.autoAttach(secondRoot);
    childEvent(f);
    const firstChild = first.child("frame", root);
    const secondChild = second.child("frame", secondRoot);
    expect(firstChild).not.toBe(secondChild);
    expectEvent(second, "Target.attachedToTarget", secondRoot, {
      sessionId: secondChild,
      targetInfo: { type: "iframe", targetId: "frame" },
      waitingForDebugger: false,
    });
    await first.request("Runtime.enable", firstChild);
    const response = await second.request("Runtime.enable", secondChild);
    expectReplay(second.socket, secondChild, response.id, [runtimeContext(2)]);
    expect(contextFrames(first.socket, firstChild)).toHaveLength(1);
    await first.request("Target.detachFromTarget", root, { sessionId: firstChild });
    expectDetached(first, root, firstChild, "frame");
    created(4, "child");
    expect(contextFrames(first.socket, firstChild)).toHaveLength(1);
    expect(contexts(second, secondChild).at(-1)).toEqual({ context: runtimeContext(4) });
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "frame" });
    expectDetached(second, secondRoot, secondChild, "frame");
    expect((await second.request("Runtime.enable", secondChild)).error).toBeDefined();
    expect(f.commands("Target.detachFromTarget")).toEqual([]);
  });

  it("rejects unannounced and foreign root, alias, browser and child sessions without forwarding", async () => {
    const { client: owner, root } = await attach();
    const browser = await owner.session("Target.attachToBrowserTarget");
    const alias = await owner.session("Target.attachToTarget", browser, {
      targetId: "target-1",
      flatten: true,
    });
    await owner.autoAttach(root);
    f.event("Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { type: "worker", targetId: "worker" },
    });
    const child = owner.child("worker", root);
    const foreign = f.client();
    for (const session of [root, alias, browser, child, "missing"]) {
      expect((await foreign.request("Runtime.evaluate", session)).error).toBeDefined();
      expect(
        (await foreign.request("Target.detachFromTarget", undefined, { sessionId: session })).error,
      ).toBeDefined();
    }
    expect(f.commands("Runtime.evaluate")).toEqual([]);
    expect((await owner.request("Runtime.evaluate", root)).error).toBeUndefined();
  });

  it("does not resume a disabled or closed client's pending enable or accept messages after close", async () => {
    const closed = f.client();
    const live = f.client();
    const root = await closed.attach();
    const liveRoot = await live.attach();
    f.hold();
    closed.send("Runtime.enable", root);
    const pending = live.send("Runtime.enable", liveRoot);
    await flush();
    const closing = closed.handlers.onClose();
    await live.request("Runtime.disable", liveRoot);
    const before = closed.socket.frames().length;
    closed.send("Runtime.evaluate", root);
    f.release();
    await closing;
    await flush();
    expect(closed.socket.frames()).toHaveLength(before);
    expect(f.commands("Runtime.evaluate")).toEqual([]);
    expect(live.frame(pending)?.error).toBeDefined();
    const eventsBefore = contextFrames(live.socket, liveRoot).length;
    created(3);
    expect(contextFrames(live.socket, liveRoot)).toHaveLength(eventsBefore);
    await live.request("Runtime.enable", liveRoot);
    expect(contexts(live, liveRoot).slice(eventsBefore)).toEqual(
      [1, 3].map((id) => ({ context: runtimeContext(id) })),
    );
  });

  it.each(["extension loss", "native detach", "access loss", "bridge disposal"])(
    "retires every logical target identity on %s",
    async (ending) => {
      const { client: c, root } = await attach();
      const browser = await c.session("Target.attachToBrowserTarget");
      const alias = await c.session("Target.attachToTarget", browser, { targetId: "target-1" });
      const { child, grandchild } = await parentWithChildren(c, root);
      if (ending === "extension loss") {
        f.hold();
        const pending = c.send("Runtime.enable", root);
        await flush();
        f.extension.handlers.onClose();
        created(9);
        f.release();
        await flush();
        expect(c.frame(pending)?.error).toBeDefined();
        expect(contextIds(c, root)).not.toContain(9);
      }
      if (ending === "native detach") {
        event({ type: "detached", tabId: 1, reason: "target_closed" });
      }
      if (ending === "access loss") {
        event({ type: "tabs", tabs: [] });
      }
      if (ending === "bridge disposal") {
        c.socket.send = (data) => {
          expect(c.socket.closed).toBe(false);
          FakeSocket.prototype.send.call(c.socket, data);
        };
        f.bridge.dispose();
      }
      const detached = c.frames("Target.detachedFromTarget");
      expect(detached).toHaveLength(4);
      expect(detached.map((frame) => frame.params)).toEqual(
        expect.arrayContaining([
          { sessionId: root, targetId: "target-1" },
          { sessionId: alias, targetId: "target-1" },
          { sessionId: child, targetId: "frame" },
          { sessionId: grandchild, targetId: "worker" },
        ]),
      );
      expect(
        detached.find((frame) => asOptionalRecord(frame.params)?.sessionId === alias)?.sessionId,
      ).toBe(browser);
      if (ending === "native detach") {
        expect(f.bridge.devtoolsTargetDescriptors()).toEqual([
          expect.objectContaining({ id: "target-1" }),
        ]);
        const next = await c.attach();
        expect(next).not.toBe(root);
        expect((await c.request("Runtime.enable", next)).error).toBeUndefined();
      }
      if (ending === "extension loss") {
        expect(f.bridge.devtoolsTargetDescriptors()).toEqual([
          expect.objectContaining({ id: "tab-1" }),
        ]);
        sendHello(wireExtension(f.bridge).handlers);
        const next = await c.attach();
        expect(next).not.toBe(root);
        expect((await c.request("Runtime.enable", root)).error).toBeDefined();
        await c.request("Runtime.enable", next);
        expectContexts(c, next);
      }
    },
  );

  it("uses owned child identities when detach carries an unrelated target", async () => {
    const { client: c, root } = await attach();
    await c.request("Runtime.enable", root);
    const { child, grandchild } = await parentWithChildren(c, root);
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "unrelated-target" });
    expect(c.frames("Target.detachedFromTarget").map((frame) => frame.params)).toEqual([
      { sessionId: child, targetId: "frame" },
      { sessionId: grandchild, targetId: "worker" },
    ]);
    expect((await c.request("Page.getFrameTree", root)).error).toBeUndefined();
    expect(f.extension.socket.frames().filter((frame) => frame.type === "detach")).toEqual([]);
    expect(contextFrames(c.socket, root)).toHaveLength(1);
  });

  it("delivers live events during admission and replays only undelivered current contexts after success", async () => {
    const { client: first, root } = await attach();
    await first.request("Runtime.enable", root);
    created(2);
    const { client: late, root: lateRoot } = await attach();
    f.hold();
    const pending = late.send("Runtime.enable", lateRoot);
    await flush();
    expect.soft(contextFrames(late.socket, lateRoot)).toEqual([]);
    expect.soft(late.frame(pending)).toBeUndefined();
    created(3);
    f.event("Runtime.consoleAPICalled", { type: "log", args: [] });
    f.event("Runtime.executionContextDestroyed", { executionContextId: 1 });
    expectContexts(late, lateRoot, 3);
    expectEvent(late, "Runtime.consoleAPICalled", lateRoot, { type: "log", args: [] });
    f.release();
    await flush();
    expectReplay(late.socket, lateRoot, pending, [runtimeContext(3), runtimeContext(2)]);
    expect(contextFrames(first.socket, root)).toHaveLength(3);
  });

  it.each(["Runtime.removeBinding", "Target.detachFromTarget"])(
    "preserves bindings through Runtime.disable and a peer's %s, then removes the final registration",
    async (operation) => {
      const { client: first, root: firstRoot } = await attach();
      const { client: second, root: secondRoot } = await attach();
      const { client: observer, root: observerRoot } = await attach();
      const name = "sharedBinding";
      for (const [client, root] of [
        [first, firstRoot],
        [second, secondRoot],
      ] as const) {
        expect((await binding(client, root, name)).error).toBeUndefined();
      }
      await observer.request("Runtime.enable", observerRoot);
      await second.request("Runtime.enable", secondRoot);
      await second.request("Runtime.disable", secondRoot);
      await binding(observer, observerRoot, name, "Runtime.removeBinding");
      expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
      if (operation === "Target.detachFromTarget") {
        await first.request(operation, undefined, { sessionId: firstRoot });
      } else {
        await first.request(operation, firstRoot, { name });
      }
      expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
      const params = { name, payload: "still-owned", executionContextId: 1 };
      f.event("Runtime.bindingCalled", params);
      expect(bindingFrames(first)).toEqual([]);
      expect(bindingFrames(observer)).toEqual([]);
      expect(bindingFrames(second)).toEqual([
        { sessionId: secondRoot, method: "Runtime.bindingCalled", params },
      ]);
      await binding(second, secondRoot, name, "Runtime.removeBinding");
      expect(f.commands("Runtime.removeBinding").map((frame) => frame.params)).toEqual([{ name }]);
      f.event("Runtime.bindingCalled", params);
      expect(bindingFrames(second)).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "cleans up a native add admitted after logical close (peer owns same name=%s)",
    async (sameName) => {
      const { client: first, root: firstRoot } = await attach();
      const { client: second, root: secondRoot } = await attach();
      const name = "pendingBinding";
      if (sameName) {
        await binding(second, secondRoot, name);
      }
      f.hold("Runtime.addBinding");
      const pending = first.send("Runtime.addBinding", firstRoot, { name });
      await flush();
      const closing = first.handlers.onClose();
      f.release();
      await closing;
      await flush();
      expect(first.frame(pending)).toBeUndefined();
      expect(f.commands("Runtime.removeBinding")).toHaveLength(sameName ? 0 : 1);
      const params = { name, payload: "after-close", executionContextId: 1 };
      f.event("Runtime.bindingCalled", params);
      expect(bindingFrames(first)).toEqual([]);
      expect(bindingFrames(second)).toHaveLength(sameName ? 1 : 0);
    },
  );

  it.each(["Runtime.addBinding", "Runtime.removeBinding"])(
    "preserves acknowledged binding ownership when native %s fails",
    async (method) => {
      const { client, root } = await attach();
      const name = "failedBinding";
      if (method === "Runtime.removeBinding") {
        await binding(client, root, name);
      }
      f.hold(method);
      const pending = client.send(method, root, { name });
      await flush();
      event({
        type: "error",
        seq: f.commands(method).at(-1)!.seq,
        message: "native binding command failed",
      });
      await flush();
      expect(client.frame(pending)?.error).toBeDefined();
      f.release();
      f.event("Runtime.bindingCalled", { name, payload: "failure", executionContextId: 1 });
      expect(bindingFrames(client)).toHaveLength(method === "Runtime.removeBinding" ? 1 : 0);
      expect((await binding(client, root, name, method)).error).toBeUndefined();
      f.event("Runtime.bindingCalled", { name, payload: "retry", executionContextId: 1 });
      expect(bindingFrames(client)).toHaveLength(1);
    },
  );

  it("keeps a replacement physical session independent of pending retired bindings", async () => {
    const { client, root } = await attach();
    const name = "retiredBinding";
    f.hold("Runtime.addBinding");
    client.send("Runtime.addBinding", root, { name });
    await flush();
    event({ type: "detached", tabId: 1, reason: "revoked" });
    f.release();
    await flush();
    const next = await client.attach();
    expect(next).not.toBe(root);
    const params = { name, payload: "replacement", executionContextId: 11 };
    f.event("Runtime.bindingCalled", params);
    expect(bindingFrames(client)).toEqual([]);
    await binding(client, next, name);
    f.event("Runtime.bindingCalled", params);
    expect(bindingFrames(client)).toEqual([
      { sessionId: next, method: "Runtime.bindingCalled", params },
    ]);
    expect(f.commands("Runtime.removeBinding")).toHaveLength(0);
  });

  it("admits concurrent enables once per request without losing peers or repeats when one fails", async () => {
    const { client: c, root } = await attach();
    const { client: peer, root: peerRoot } = await attach();
    f.hold();
    const failed = c.send("Runtime.enable", root);
    const admitted = c.send("Runtime.enable", root);
    const repeated = c.send("Runtime.enable", root);
    const peerAdmission = peer.send("Runtime.enable", peerRoot);
    await flush();
    expect(c.frame(admitted)).toBeUndefined();
    expect(peer.frame(peerAdmission)).toBeUndefined();
    expect(f.commands("Runtime.enable")).toHaveLength(4);
    event({
      type: "error",
      seq: f.commands("Runtime.enable")[0]!.seq,
      message: "admission failed",
    });
    await flush();
    expect(c.frame(failed)?.error).toBeDefined();
    expect.soft(c.frame(admitted)).toBeUndefined();
    f.release();
    await flush();
    expect(c.frame(admitted)).toMatchObject({ result: {} });
    expect(c.frame(repeated)).toMatchObject({ result: {} });
    expectReplay(c.socket, root, admitted);
    expectReplay(peer.socket, peerRoot, peerAdmission);
    created(3);
    expect(contextFrames(c.socket, root)).toHaveLength(2);
    expect(f.commands("Runtime.disable")).toEqual([]);
  });
});
