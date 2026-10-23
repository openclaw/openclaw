import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { flush, replyFor, sendHello, wireExtension } from "./relay-bridge.test-support.js";
import type { RelayCommandBody } from "./relay-protocol.js";
import { createRelayClient, autoAttachParams as enabled } from "./relay-runtime.test-support.js";

function fixture() {
  const bridge = new ExtensionRelayBridge();
  onTestFinished(() => bridge.dispose());
  let hold: string | undefined;
  let failure: string | undefined;
  let targetId: string | undefined = "target-1";
  const held: Array<RelayCommandBody & { seq: number }> = [];
  const extension = wireExtension(bridge, (message) => {
    if (message.type === "ping") {
      return replyFor(message);
    }
    if (message.type === hold || (message.type === "cdp" && message.method === hold)) {
      held.push(message);
      return null;
    }
    if (message.type === failure || (message.type === "cdp" && message.method === failure)) {
      failure = undefined;
      return {
        type: "error",
        seq: message.seq,
        message: "native transition failed after dispatch",
      };
    }
    if (message.type === "attach") {
      return { type: "result", seq: message.seq, result: targetId ? { targetId } : {} };
    }
    return replyFor(message);
  });
  sendHello(extension.handlers);
  const native = (message: unknown) => extension.handlers.onMessage(JSON.stringify(message));
  const event = (method: string, params: unknown, sessionId?: string) =>
    native({ type: "cdpEvent", tabId: 1, method, params, sessionId });
  const child = (id: string, parent?: string, type = "worker") => {
    const targetInfo = { targetId: `target-${id}`, type, url: "https://example.com/child" };
    event(
      "Target.attachedToTarget",
      { sessionId: id, targetInfo, waitingForDebugger: true },
      parent,
    );
  };
  const commands = (method: string) =>
    extension.socket
      .frames()
      .filter((f) => f.type === method || (f.type === "cdp" && f.method === method));
  const client = () => createRelayClient(bridge, enabled, (read) => vi.waitFor(read));
  return {
    native,
    event,
    child,
    commands,
    client,
    hold: (method?: string) => {
      hold = method;
    },
    fail: (method: string) => {
      failure = method;
    },
    target: (id?: string) => {
      targetId = id;
    },
    held,
    release: () => {
      hold = undefined;
      for (const message of held.splice(0)) {
        native({
          type: "result",
          seq: message.seq,
          result: message.type === "attach" ? (targetId ? { targetId } : {}) : {},
        });
      }
    },
  };
}
type Client = ReturnType<ReturnType<typeof fixture>["client"]>;
function expectChildMessage(c: Client, root: string, child: string, message: unknown) {
  expect(c.socket.frames()).toContainEqual({
    sessionId: root,
    method: "Target.receivedMessageFromTarget",
    params: { sessionId: child, targetId: "target-child", message: JSON.stringify(message) },
  });
}

describe("pending tab acquisition claims", () => {
  it.each(["unrelated", "pending peer", "delivered peer"])(
    "releases only an abandoned acquisition with %s remaining",
    async (peer) => {
      const f = fixture();
      const first = f.client();
      await first.attach();
      const other = f.client();
      await first.close();
      await flush();
      const before = f.commands("detach").length;
      if (peer === "delivered peer") {
        await other.attach();
      }
      f.hold("attach");
      const lost = f.client();
      lost.send("Target.attachToTarget", undefined, { targetId: "target-1" });
      if (peer !== "delivered peer") {
        await vi.waitFor(() => expect(f.held).toHaveLength(1));
      }
      const waiting =
        peer === "pending peer"
          ? other.send("Target.attachToTarget", undefined, { targetId: "target-1" })
          : undefined;
      const closing = lost.close();
      f.release();
      await closing;
      if (waiting !== undefined) {
        expect((await other.response(waiting)).error).toBeUndefined();
      }
      await flush();
      if (peer === "unrelated") {
        expect(f.commands("detach")).toHaveLength(before + 1);
      } else {
        expect(f.commands("detach")).toHaveLength(before);
        expect(other.attached()).toHaveLength(1);
      }
    },
  );

  it("rejects requested target substitution without retiring a pending peer's successor", async () => {
    const f = fixture();
    const c = f.client();
    await c.attach();
    f.native({ type: "detached", tabId: 1, reason: "target_closed" });
    f.hold("attach");
    const request = c.send("Target.attachToTarget", undefined, { targetId: "target-1" });
    const peer = f.client();
    const pending = peer.send("Target.setAutoAttach", undefined, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.target("target-2");
    f.release();
    expect.soft((await c.response(request)).error).toBeDefined();
    await peer.response(pending);
    expect.soft(c.attached()).toHaveLength(2);
    expect(c.attached()[1]).toMatchObject({ targetInfo: { targetId: "target-2" } });
    expect(peer.attached()).toMatchObject([{ targetInfo: { targetId: "target-2" } }]);
    expect(f.commands("detach")).toEqual([]);
  });

  it("never fabricates a successful native identity", async () => {
    const f = fixture();
    f.target(undefined);
    const c = f.client();
    await c.request("Target.setAutoAttach", undefined, enabled);
    expect(c.attached()).toEqual([]);
    expect((await c.request("Target.getTargets")).error).toBeDefined();
  });

  it("allows an explicit acquire after a failed retirement has settled", async () => {
    const f = fixture();
    const c = f.client();
    const root = await c.attach();
    f.fail("detach");
    expect(
      (await c.request("Target.detachFromTarget", undefined, { sessionId: root })).error,
    ).toBeDefined();
    expect
      .soft((await c.request("Target.attachToTarget", undefined, { targetId: "target-1" })).error)
      .toBeUndefined();
    expect(f.commands("attach")).toHaveLength(2);
  });
});

describe("logical Target interests", () => {
  let f: ReturnType<typeof fixture>;
  let c: Client;
  let root: string;
  beforeEach(async () => {
    f = fixture();
    c = f.client();
    root = await c.attach();
  });
  const autoAttach = (session: string, overrides: Record<string, unknown> = {}) =>
    c.request("Target.setAutoAttach", session, { ...enabled, ...overrides });
  const error = async (...args: Parameters<Client["request"]>) => (await c.request(...args)).error;
  async function attachChild(flatten = true) {
    await autoAttach(root, { flatten });
    f.child("child");
    return c.latestChild(root);
  }
  const sendChild = (target: { sessionId: string } | { targetId: string }, message: unknown) =>
    c.request("Target.sendMessageToTarget", root, { ...target, message: JSON.stringify(message) });

  it("keeps distinct child aliases and the surviving parent's Runtime/Fetch after parent detach", async () => {
    const s2 = await c.alias();
    for (const parent of [root, s2]) {
      await autoAttach(parent);
    }
    f.child("child");
    const a = c.latestChild(root);
    const b = c.latestChild(s2);
    expect(a).not.toBe(b);
    await c.request("Fetch.enable", b, {});
    expect(await error("Fetch.enable", a, {})).toBeDefined();
    await c.request("Target.detachFromTarget", undefined, { sessionId: root });
    for (const method of ["Runtime.enable", "Runtime.evaluate", "Fetch.disable"]) {
      expect(await error(method, b)).toBeUndefined();
    }
    expect(f.commands("Target.detachFromTarget")).toEqual([]);
    expect(c.socket.frames()).toContainEqual({
      sessionId: root,
      method: "Target.detachedFromTarget",
      params: { sessionId: a, targetId: "target-child" },
    });
  });

  it("replays late children and grandchildren only after current admission with current waiting state", async () => {
    await autoAttach(root);
    f.child("child");
    const a = c.latestChild(root);
    await autoAttach(a);
    f.child("grandchild", "child");
    await c.request("Runtime.runIfWaitingForDebugger", a);
    const s2 = await c.alias();
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", s2, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect(c.attached(s2)).toEqual([]);
    f.release();
    await c.response(pending);
    const b = c.latestChild(s2);
    expect(c.attached(s2)[0]).toMatchObject({ waitingForDebugger: false });
    expect(c.attached(b)).toEqual([]);
    await autoAttach(b);
    expect(c.attached(b)).toHaveLength(1);
    expect(c.latestChild(a)).not.toBe(c.latestChild(b));
  });

  it("admits a broader filter before replaying its newly included children", async () => {
    const peer = await c.alias();
    await autoAttach(root, { filter: [{ type: "worker" }] });
    await autoAttach(peer, { filter: [{}] });
    f.child("frame", undefined, "iframe");
    expect(c.attached(root)).toEqual([]);
    expect(c.attached(peer)).toHaveLength(1);
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", root, { ...enabled, filter: [{}] });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect.soft(c.attached(root)).toEqual([]);
    f.release();
    expect((await c.response(pending)).error).toBeUndefined();
    expect(c.attached(root)).toHaveLength(1);
    expect(c.latestChild(root)).not.toBe(c.latestChild(peer));
  });

  it("unions ordered native filters without conflating omitted filter and catch-all", async () => {
    const s2 = await c.alias();
    expect((await autoAttach(root)).error).toBeUndefined();
    expect((await autoAttach(s2, { filter: [{}] })).error).toBeUndefined();
    f.child("tab", undefined, "tab");
    f.child("worker");
    expect.soft(c.attached(root)).toHaveLength(1);
    expect(c.attached(s2)).toHaveLength(2);
    await autoAttach(root, { waitForDebuggerOnStart: false });
    expect(f.commands("Target.setAutoAttach").at(-1)?.params).toMatchObject({
      waitForDebuggerOnStart: false,
      filter: [{}],
    });
    await autoAttach(s2, { filter: [{ type: "worker", exclude: true }, {}] });
    f.child("next-worker");
    expect(c.attached(root)).toHaveLength(2);
    expect(c.attached(s2)).toHaveLength(2);
  });

  it.each(["enable", "disable"])(
    "retires uncertain native %s transitions visibly without disconnecting clients",
    async (transition) => {
      if (transition === "disable") {
        await autoAttach(root);
        f.child("child");
      }
      f.fail("Target.setAutoAttach");
      expect((await autoAttach(root, { autoAttach: transition === "enable" })).error).toBeDefined();
      expect.soft(await error("Runtime.evaluate", root)).toBeDefined();
      expect(c.socket.closed).toBe(false);
      await flush();
      expect(f.commands("detach")).toHaveLength(1);
    },
  );

  it("routes non-flat child commands by targetId through the same logical owner", async () => {
    const child = await attachChild(false);
    expect(child).not.toBe("child");
    await sendChild({ targetId: "target-child" }, { id: 71, method: "Runtime.evaluate" });
    await vi.waitFor(() =>
      expectChildMessage(c, root, child, {
        id: 71,
        result: { ok: true, echoed: "Runtime.evaluate" },
      }),
    );
    expect(f.commands("Runtime.evaluate").at(-1)?.sessionId).toBe("child");
  });
  it("projects and updates child metadata only for interested parents", async () => {
    const parent = await c.alias();
    await autoAttach(parent);
    f.child("child");
    expect.soft(c.attached(root)).toEqual([]);
    expect(c.attached(parent)).toHaveLength(1);
    const info = { targetId: "target-child", type: "worker", url: "https://example.com/updated" };
    f.event("Target.targetInfoChanged", { targetInfo: info });
    expect
      .soft(c.frames("Target.targetInfoChanged"))
      .toEqual([
        { sessionId: parent, method: "Target.targetInfoChanged", params: { targetInfo: info } },
      ]);
    await autoAttach(root);
    expect(c.attached(root)[0]).toMatchObject({ targetInfo: info });
  });

  it("does not serialize ordinary commands or an independent child behind a parent transition", async () => {
    const child = await attachChild();
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", root, {
      ...enabled,
      waitForDebuggerOnStart: false,
    });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    expect(await error("Runtime.evaluate", root)).toBeUndefined();
    expect(await error("Runtime.enable", root)).toBeUndefined();
    expect(await error("Fetch.enable", child)).toBeUndefined();
    f.hold(undefined);
    expect((await autoAttach(child)).error).toBeUndefined();
    expect(c.socket.frames().find((frame) => frame.id === pending)).toBeUndefined();
    f.release();
    expect((await c.response(pending)).error).toBeUndefined();
  });

  it("retires a partially mutating enable and discards its late native child", async () => {
    f.hold("Target.setAutoAttach");
    const pending = c.send("Target.setAutoAttach", root, enabled);
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.child("child");
    expect(c.attached(root)).toEqual([]);
    f.native({ type: "error", seq: f.held[0]!.seq, message: "post-command admission failed" });
    expect((await c.response(pending)).error).toBeDefined();
    f.child("late-child");
    expect(c.attached(root)).toEqual([]);
    expect(await error("Runtime.evaluate", root)).toBeDefined();
    expect(c.socket.closed).toBe(false);
  });

  it("does not reuse child aliases after the native parent is replaced", async () => {
    const old = await attachChild();
    f.native({ type: "detached", tabId: 1, reason: "target_closed" });
    const next = await c.attach();
    await autoAttach(next);
    f.child("child");
    const fresh = c.latestChild(next);
    expect(fresh).not.toBe(old);
    expect(await error("Runtime.evaluate", old)).toBeDefined();
    expect(await error("Runtime.evaluate", fresh)).toBeUndefined();
  });

  it("routes a flat descendant through its non-flat ancestor transport", async () => {
    const child = await attachChild(false);
    await sendChild(
      { sessionId: child },
      { id: 101, method: "Target.setAutoAttach", params: enabled },
    );
    await flush();
    f.child("grandchild", "child");
    const nested = c
      .frames("Target.receivedMessageFromTarget")
      .map((frame) => JSON.parse(String(asOptionalRecord(frame.params)?.message)));
    const grandchild = nested.find((frame) => frame.method === "Target.attachedToTarget")?.params
      .sessionId;
    expect(typeof grandchild).toBe("string");
    await sendChild(
      { sessionId: child },
      { id: 102, sessionId: grandchild, method: "Runtime.evaluate" },
    );
    await flush();
    expect.soft(f.commands("Runtime.evaluate").at(-1)?.sessionId).toBe("grandchild");
    expectChildMessage(c, root, child, {
      id: 102,
      result: { ok: true, echoed: "Runtime.evaluate" },
      sessionId: grandchild,
    });
  });

  it("does not detach an already-closed child after held Fetch cleanup finishes", async () => {
    const child = await attachChild();
    await c.request("Fetch.enable", child);
    f.event("Fetch.requestPaused", { requestId: "paused" }, "child");
    f.hold("Fetch.failRequest");
    const detaching = c.send("Target.detachFromTarget", root, { sessionId: child });
    await vi.waitFor(() => expect(f.held).toHaveLength(1));
    f.event("Target.detachedFromTarget", { sessionId: "child", targetId: "target-child" });
    f.fail("Target.detachFromTarget");
    f.release();
    expect.soft((await c.response(detaching)).error).toBeUndefined();
    expect.soft(f.commands("Target.detachFromTarget")).toEqual([]);
    expect(await error("Runtime.evaluate", root)).toBeUndefined();
  });
});
