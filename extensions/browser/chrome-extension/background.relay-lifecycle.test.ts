import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectType,
  expectUnused,
  deferredScope,
  holdNext,
  relayConfig,
  runtime,
  waitCalled,
} from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses, loadBackground } from "./background.test-harness.js";
import { FakeWebSocket } from "./background.test-support.js";
const tabId = 7;
const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const frames = (socket: FakeWebSocket): Array<Record<string, unknown>> =>
  socket.send.mock.calls.map(([raw]) => JSON.parse(raw));
const findFrame = (socket: FakeWebSocket, seq: number) =>
  frames(socket).find((entry) => entry.seq === seq);
const expectRuntime = (socket: FakeWebSocket) =>
  expect(
    frames(socket).filter((entry) => entry.method === "Runtime.executionContextCreated"),
  ).toHaveLength(1);
const waitType = (socket: FakeWebSocket, seq: number, type = "result") =>
  vi.waitFor(() => expectType(findFrame(socket, seq), type));
const attachedResult = { type: "result", seq: 1, result: { targetId: "target-7" } };
const waitAttached = (socket: FakeWebSocket) =>
  vi.waitFor(() => expect(frames(socket)).toContainEqual(attachedResult));

async function reply(socket: FakeWebSocket, seq: number, message: Record<string, unknown>) {
  const before = frames(socket).length;
  socket.receive({ seq, ...message });
  return await vi.waitFor(() => {
    const result = frames(socket)
      .slice(before)
      .find((frame) => (message.type === "ping" ? frame.type === "pong" : frame.seq === seq));
    expect(result).toBeDefined();
    return result!;
  });
}

async function fixture(initiallyAttached = false) {
  const h = await loadBackground({
    deferSocketClose: true,
    storedConfig: relayConfig("all"),
    initialTabs: [{ id: tabId, url: "https://example.com/live", groupId: -1, incognito: false }],
  });
  const attached = new Map<number, { runtimeEnabled: boolean }>();
  h.debuggerAttach.mockImplementation(async ({ tabId: id }) => {
    if (attached.has(id)) {
      throw new Error(`Another debugger is already attached to the tab with id: ${id}.`);
    }
    attached.set(id, { runtimeEnabled: false });
  });
  h.debuggerDetach.mockImplementation(async (source) => {
    const id = source.tabId ?? Number(source.targetId?.slice("target-".length));
    if (!attached.delete(id)) {
      throw new Error(`Debugger is not attached to the target with id: target-${id}.`);
    }
    // Native programmatic detach does not emit the user onDetach event.
  });
  h.debuggerGetTargetInfo.mockImplementation(async ({ tabId: id }) => {
    if (!attached.has(id)) {
      throw new Error("Debugger is not attached");
    }
    return { targetInfo: { targetId: `target-${id}` } };
  });
  h.debuggerSendCommand.mockImplementation(async (source, method) => {
    const session = attached.get(source.tabId);
    if (!session) {
      throw new Error("Debugger is not attached");
    }
    if (method === "Runtime.enable" && !session.runtimeEnabled) {
      session.runtimeEnabled = true;
      h.debuggerEventListener?.(source, "Runtime.executionContextCreated", {
        context: { id: 3, auxData: { isDefault: true } },
      });
    }
    return {};
  });
  const old = h.relaySockets[0]!;
  await h.authenticate(old);
  async function replacement() {
    h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(h.relaySockets).toHaveLength(2));
    const socket = h.relaySockets[1]!;
    await h.authenticate(socket);
    return socket;
  }
  async function attach(socket: FakeWebSocket, seq = 1) {
    expect(await reply(socket, seq, { type: "attach", tabId })).toMatchObject({
      type: "result",
      result: { targetId: `target-${tabId}` },
    });
  }
  if (initiallyAttached) {
    await attach(old);
  }
  return { h, old, attached, replacement, attach };
}
const { deferred, releaseAll } = deferredScope();
function heldAccess(h: Awaited<ReturnType<typeof loadBackground>>) {
  const gate = deferred(undefined);
  h.tabsGet.mockClear();
  holdNext(h.tabsGet, gate.promise);
  return gate;
}
function heldFocus(h: Awaited<ReturnType<typeof loadBackground>>) {
  const gate = deferred(undefined);
  h.windowsUpdate.mockImplementationOnce(async () => {
    await gate.promise;
  });
  return gate;
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
  releaseAll();
  await flush();
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authenticated relay debugger lifetime", () => {
  it("starts a fresh Runtime after authentication failure without changing grants", async () => {
    const f = await fixture(true);
    await reply(f.old, 2, { type: "cdp", tabId, method: "Runtime.enable" });
    f.attached.set(99, { runtimeEnabled: true });
    f.old.receive({ type: "auth.invalid" });
    await waitCalled(f.old.close);
    const next = await f.replacement();
    await f.attach(next);
    await reply(next, 2, { type: "cdp", tabId, method: "Runtime.enable" });
    expectRuntime(next);
    expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: "target-7" });
    expect(f.h.debuggerDetach).not.toHaveBeenCalledWith({ targetId: "target-99" });
    expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
    expect(f.h.sessionStorageValues).not.toHaveProperty("deniedTabIdsV1");
    expect(await runtime(f.h, "getTabAccess", { tabId })).toMatchObject({
      accessible: true,
      denied: false,
    });
  });
  it.each(["attach", "target lookup"])(
    "drains a delayed old %s and detach before replacement attachment",
    async (phase) => {
      const f = await fixture();
      const gate = deferred(undefined);
      const detachGate = deferred(undefined);
      if (phase === "attach") {
        holdNext(f.h.debuggerAttach, gate.promise);
      } else {
        holdNext(f.h.debuggerGetTargetInfo, gate.promise);
      }
      holdNext(f.h.debuggerDetach, detachGate.promise);
      f.old.receive({ type: "attach", seq: 44, tabId });
      await waitCalled(phase === "attach" ? f.h.debuggerAttach : f.h.debuggerGetTargetInfo);
      f.old.close();
      const next = await f.replacement();
      next.receive({ type: "attach", seq: 1, tabId });
      await reply(next, 2, { type: "ping" });
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
      expect(frames(next).some((frame) => frame.seq === 1)).toBe(false);
      gate.resolve();
      await waitCalled(f.h.debuggerDetach, { targetId: `target-${tabId}` });
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
      detachGate.resolve();
      await waitAttached(next);
      expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
      const detaches = f.h.debuggerDetach.mock.calls.length;
      f.old.finishClose();
      await reply(next, 3, { type: "cdp", tabId, method: "Runtime.enable" });
      expect(f.h.debuggerDetach).toHaveBeenCalledTimes(detaches);
      expect(frames(next).some((frame) => frame.seq === 44)).toBe(false);
      expectRuntime(next);
    },
  );
  it("detaches without waiting for old evaluation and never delivers its reply on a colliding new seq", async () => {
    const f = await fixture(true);
    const gate = deferred<Record<string, unknown>>({});
    f.h.debuggerSendCommand.mockImplementationOnce(async () => await gate.promise);
    f.old.receive({ type: "cdp", seq: 9, tabId, method: "Runtime.evaluate" });
    await waitCalled(f.h.debuggerSendCommand);
    f.old.finishClose();
    const next = await f.replacement();
    await f.attach(next);
    expect(f.h.debuggerDetach).toHaveBeenCalledWith({ targetId: `target-${tabId}` });
    await reply(next, 9, { type: "cdp", tabId, method: "Runtime.enable" });
    gate.resolve({ stale: true });
    await flush();
    await reply(next, 10, { type: "ping" });
    expect(frames(next).filter((frame) => frame.seq === 9)).toEqual([
      { type: "result", seq: 9, result: {} },
    ]);
    expect(frames(f.old).some((frame) => frame.seq === 9)).toBe(false);
  });
  it.each(["activateTab", "createTab"])(
    "fences %s paused over a tab lookup while preserving creator-owned rollback",
    async (type) => {
      const f = await fixture(true);
      const gate = heldAccess(f.h);
      f.old.receive({
        type,
        seq: 8,
        tabId,
        method: "Runtime.evaluate",
        url: "https://example.com/new",
      });
      await waitCalled(f.h.tabsGet);
      f.old.finishClose();
      const next = await f.replacement();
      gate.resolve();
      await flush();
      await f.attach(next);
      expectUnused(f.h.debuggerSendCommand, f.h.tabsUpdate, f.h.windowsUpdate);
      if (type === "createTab") {
        expect(f.h.tabsRemove).toHaveBeenCalledExactlyOnceWith(tabId + 1);
        expect(await f.h.tabsQuery()).toEqual([expect.objectContaining({ id: tabId })]);
      } else {
        expectUnused(f.h.tabsRemove);
      }
      expectUnused(f.h.tabsGroup);
      expect(frames(next).some((frame) => frame.seq === 8)).toBe(false);
      expect(frames(f.old).some((frame) => frame.seq === 8)).toBe(false);
    },
  );
  it.each(["cdp", "attach"])(
    "fences replacement %s work while the old native session retires",
    async (type) => {
      const f = await fixture(true);
      const gate = deferred(undefined);
      holdNext(f.h.debuggerDetach, gate.promise);
      f.old.finishClose();
      const next = await f.replacement();
      next.receive({
        type,
        seq: 9,
        tabId,
        ...(type === "cdp" ? { method: "Runtime.evaluate" } : {}),
      });
      await reply(next, 10, { type: "ping" });
      if (type === "attach") {
        f.h.updateTab(tabId, { url: "chrome://settings" });
        f.h.updateTab(tabId, { url: "https://example.com/returned" });
      } else {
        expectUnused(f.h.debuggerSendCommand);
      }
      gate.resolve();
      await vi.waitFor(() =>
        expect(frames(next)).toContainEqual({
          type: "error",
          seq: 9,
          message: expect.stringContaining(type === "cdp" ? "not attached" : "access was revoked"),
        }),
      );
      if (type === "attach") {
        expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
        await f.attach(next, 11);
        expect(f.h.debuggerAttach).toHaveBeenCalledTimes(2);
      } else {
        await f.attach(next);
        await reply(next, 11, { type: "cdp", tabId, method: "Runtime.enable" });
        expectRuntime(next);
      }
    },
  );
  it("keeps retirement fenced through an opening deadline and delayed stale close", async () => {
    const f = await fixture(true);
    const gate = deferred(undefined);
    holdNext(f.h.debuggerDetach, gate.promise);
    f.old.close();
    f.h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(f.h.relaySockets).toHaveLength(2));
    const expired = f.h.relaySockets[1]!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);
    f.h.alarmListener({ name: "openclaw-relay-opening-deadline" });
    clock.mockRestore();
    expect(expired.close).toHaveBeenCalledWith(4001, "relay authentication timed out");
    f.h.alarmListener({ name: "openclaw-relay-watchdog" });
    await vi.waitFor(() => expect(f.h.relaySockets).toHaveLength(3));
    const next = f.h.relaySockets[2]!;
    await f.h.authenticate(next);
    next.receive({ type: "attach", seq: 1, tabId });
    await reply(next, 2, { type: "ping" });
    expect(frames(next).some((frame) => frame.seq === 1)).toBe(false);
    f.old.finishClose();
    expired.finishClose();
    gate.resolve();
    await waitAttached(next);
    await reply(next, 3, { type: "cdp", tabId, method: "Runtime.enable" });
    expectRuntime(next);
  });
  it("fails closed when physical retirement cannot prove detach", async () => {
    const f = await fixture(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.h.debuggerDetach.mockRejectedValue(new Error("native detach refused"));
    f.old.finishClose();
    const next = await f.replacement();
    expect(await reply(next, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("native detach refused"),
    });
    expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
  });
  it("does not adopt or retire an attachment when Chrome rejects ownership", async () => {
    const f = await fixture();
    f.attached.set(tabId, { runtimeEnabled: true });
    expect(await reply(f.old, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("Another debugger is already attached"),
    });
    f.old.finishClose();
    const next = await f.replacement();
    expect(await reply(next, 1, { type: "attach", tabId })).toMatchObject({
      type: "error",
      message: expect.stringContaining("Another debugger is already attached"),
    });
    expectUnused(f.h.debuggerDetach);
    expect(f.attached.get(tabId)).toEqual({ runtimeEnabled: true });
  });
});

it.each(["before dispatch", "native completion", "post-access completion"])(
  "rejects old work held at %s across detach and reattach",
  async (stage) => {
    const f = await fixture(true);
    const gate = deferred(undefined);
    const entered = deferred(undefined);
    const getTab = f.h.tabsGet.getMockImplementation()!;
    const holdAccess = () =>
      f.h.tabsGet.mockImplementationOnce(async (id) => {
        entered.resolve();
        await gate.promise;
        return getTab(id);
      });
    if (stage === "before dispatch") {
      holdAccess();
    } else {
      f.h.debuggerSendCommand.mockImplementationOnce(async () => {
        if (stage === "native completion") {
          entered.resolve();
          await gate.promise;
        } else {
          holdAccess();
        }
        return { oldGeneration: true };
      });
    }
    f.old.receive({ type: "cdp", seq: 90, tabId, method: "Runtime.evaluate" });
    await entered.promise;
    await reply(f.old, 91, { type: "detach", tabId });
    await f.attach(f.old, 92);
    gate.resolve();
    await waitType(f.old, 90, "error");
    expect(f.h.debuggerSendCommand).toHaveBeenCalledTimes(stage === "before dispatch" ? 0 : 1);
    expectType(await reply(f.old, 93, { type: "cdp", tabId, method: "Runtime.enable" }));
  },
);

describe("native attachment retirement ordering", () => {
  it("fences creation handoff after native replacement and preserves a user-taken-over tab", async () => {
    const f = await fixture();
    const gate = heldFocus(f.h);
    const createdTabId = tabId + 1;
    f.old.receive({ type: "createTab", seq: 80, url: "https://example.com/new", focus: true });
    await waitCalled(f.h.windowsUpdate);
    f.h.updateTab(createdTabId, { title: "Still focusing" });
    await vi.waitFor(() =>
      expect(frames(f.old).findLast((frame) => frame.type === "tabs")?.tabs).toEqual([
        expect.objectContaining({ tabId }),
      ]),
    );
    expectUnused(f.h.debuggerDetach);
    await reply(f.old, 81, { type: "detach", tabId: createdTabId });
    expectType(await reply(f.old, 82, { type: "attach", tabId: createdTabId }));
    f.h.updateTab(createdTabId, { url: "https://example.com/user-takeover" });
    gate.resolve();
    await waitType(f.old, 80, "error");
    expectUnused(f.h.tabsRemove);
    expectType(
      await reply(f.old, 83, { type: "cdp", tabId: createdTabId, method: "Runtime.enable" }),
    );
  });
  it("does not hand off a pending native attach overtaken by explicit detach", async () => {
    const f = await fixture();
    const gate = deferred(undefined);
    const detachGate = deferred(undefined);
    holdNext(f.h.debuggerAttach, gate.promise);
    holdNext(f.h.debuggerDetach, detachGate.promise);
    f.old.receive({ type: "attach", seq: 70, tabId });
    await vi.waitFor(() => expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1));
    f.old.receive({ type: "detach", seq: 71, tabId });
    f.old.receive({ type: "attach", seq: 72, tabId });
    await reply(f.old, 73, { type: "ping" });
    expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitCalled(f.h.debuggerDetach);
    expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
    detachGate.resolve();
    await waitType(f.old, 72);
    expectType(findFrame(f.old, 70), "error");
  });
  it.each(["native detach", "removal", "access loss"])(
    "synchronously invalidates commands before %s reconciliation awaits",
    async (ending) => {
      const f = await fixture(true);
      const gate = heldAccess(f.h);
      f.old.receive({ type: "cdp", seq: 60, tabId, method: "Runtime.evaluate" });
      await waitCalled(f.h.tabsGet);
      if (ending === "native detach") {
        f.attached.delete(tabId);
        f.h.debuggerDetachListener?.({ tabId }, "target_closed");
      } else if (ending === "removal") {
        f.attached.delete(tabId);
        f.h.tabsRemovedListener?.(tabId);
      } else {
        f.h.updateTab(tabId, { url: "chrome://settings" });
        await waitCalled(f.h.debuggerDetach);
        f.h.updateTab(tabId, { url: "https://example.com/returned" });
      }
      await f.attach(f.old, 61);
      gate.resolve();
      await waitType(f.old, 60, "error");
      expectUnused(f.h.debuggerSendCommand);
      expectType(await reply(f.old, 62, { type: "cdp", tabId, method: "Runtime.enable" }));
    },
  );
});

it("cancels attach admission when a same-socket detach arrives before native dispatch", async () => {
  const f = await fixture();
  f.old.receive({ type: "attach", seq: 51, tabId });
  f.old.receive({ type: "detach", seq: 52, tabId });
  f.old.receive({ type: "attach", seq: 53, tabId });
  await waitType(f.old, 53);
  expectType(findFrame(f.old, 51), "error");
  expect(f.h.debuggerAttach).toHaveBeenCalledTimes(1);
});

it("rolls back only its created tab after socket close during focus", async () => {
  const f = await fixture();
  const gate = heldFocus(f.h);
  f.old.receive({ type: "createTab", seq: 80, url: "https://example.com/new", focus: true });
  await waitCalled(f.h.windowsUpdate);
  f.old.finishClose();
  gate.resolve();
  await vi.waitFor(() => expect(f.h.tabsRemove).toHaveBeenCalledExactlyOnceWith(tabId + 1));
  expect(await f.h.tabsQuery()).toEqual([expect.objectContaining({ id: tabId })]);
  expect(frames(f.old).some((frame) => frame.seq === 80 && frame.type === "result")).toBe(false);
});
