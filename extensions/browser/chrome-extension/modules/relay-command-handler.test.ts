import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelayCommandHandler } from "./relay-command-handler.js";

const navigationResult = { frameId: "root", loaderId: "blank-loader" };
function createHarness() {
  const epoch = { revision: 1, groupRevision: 0, tabRevision: 2 };
  const chromeMock = {
    debugger: { sendCommand: vi.fn(async () => ({ value: 1 })) },
    tabs: {
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  const dependencies = {
    send: vi.fn(),
    isCurrent: () => true,
    attachDebugger: vi.fn(),
    captureDebugger: vi.fn(() => () => {}),
    detachDebugger: vi.fn(async () => undefined),
    createTab: vi.fn(),
    scheduleTabsSync: vi.fn(),
    focusWindowForTab: vi.fn(async () => undefined),
    captureAccess: vi.fn(() => epoch),
    navigateTab: vi.fn(async () => ({ frameId: "root", loaderId: "blank-loader" })),
    requireAccessibleTab: vi.fn(async () => ({ id: 7, windowId: 3 })),
    requireNavigatedTab: vi.fn(async () => ({ id: 7, windowId: 3 })),
  };
  const handler = createRelayCommandHandler(dependencies);
  return { ...dependencies, chromeMock, epoch, handler };
}
function expectOrder(...order: Array<number | undefined>) {
  for (let i = 1; i < order.length; i++) {
    const [before, after] = [order[i - 1], order[i]];
    assert(before !== undefined && after !== undefined);
    expect(before).toBeLessThan(after);
  }
}
let ctx: ReturnType<typeof createHarness>;
beforeEach(() => {
  ctx = createHarness();
});
afterEach(() => vi.unstubAllGlobals());

describe("relay authority rechecks", () => {
  it.each([
    { name: "evaluation", method: "Runtime.evaluate", params: undefined, sessionId: undefined },
    {
      name: "blank fragment navigation",
      method: "Page.navigate",
      params: { url: "about:blank#other" },
      sessionId: undefined,
    },
    {
      name: "child-session blank navigation",
      method: "Page.navigate",
      params: { url: "about:blank" },
      sessionId: "child",
    },
  ])("checks ordinary access around native $name", async ({ method, params, sessionId }) => {
    await ctx.handler({ type: "cdp", seq: 1, tabId: 7, method, params, sessionId });
    expect(ctx.chromeMock.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith(
      sessionId ? { tabId: 7, sessionId } : { tabId: 7 },
      method,
      params ?? {},
    );
    expect(ctx.requireAccessibleTab.mock.calls).toEqual([
      [7, ctx.epoch],
      [7, ctx.epoch],
    ]);
    const [beforeCommand, afterCommand] = ctx.requireAccessibleTab.mock.invocationCallOrder;
    const [command] = ctx.chromeMock.debugger.sendCommand.mock.invocationCallOrder;
    expectOrder(beforeCommand, command, afterCommand);
    expect(ctx.navigateTab).not.toHaveBeenCalled();
    expect(ctx.requireNavigatedTab).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith({ type: "result", seq: 1, result: { value: 1 } });
  });
  it("routes root sessionless literal blank navigation through provenance and its post-check", async () => {
    const params = { url: "about:blank", frameId: "root" };
    await ctx.handler({ type: "cdp", seq: 5, tabId: 7, method: "Page.navigate", params });
    expect(ctx.requireAccessibleTab).toHaveBeenCalledExactlyOnceWith(7, ctx.epoch);
    expect(ctx.navigateTab).toHaveBeenCalledExactlyOnceWith(
      7,
      ctx.epoch,
      params,
      expect.any(Function),
      expect.any(Function),
    );
    expect(ctx.requireNavigatedTab).toHaveBeenCalledExactlyOnceWith(7, ctx.epoch);
    expectOrder(
      ctx.requireAccessibleTab.mock.invocationCallOrder[0],
      ctx.navigateTab.mock.invocationCallOrder[0],
      ctx.requireNavigatedTab.mock.invocationCallOrder[0],
    );
    expect(ctx.chromeMock.debugger.sendCommand).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith({ type: "result", seq: 5, result: navigationResult });
  });
  it("reports a revoked navigated-tab post-check instead of a successful native result", async () => {
    const message = "tab 7 navigation was revoked";
    ctx.requireNavigatedTab.mockRejectedValueOnce(new Error(message));
    const params = { url: "about:blank" };
    await ctx.handler({ type: "cdp", seq: 6, tabId: 7, method: "Page.navigate", params });
    expect(ctx.navigateTab).toHaveBeenCalledOnce();
    expect(ctx.send).toHaveBeenCalledExactlyOnceWith({ type: "error", seq: 6, message });
  });
  it("checks access around tab activation and window focus", async () => {
    await ctx.handler({ type: "activateTab", seq: 2, tabId: 7 });
    expect(ctx.requireAccessibleTab).toHaveBeenCalledTimes(3);
    expect(ctx.chromeMock.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(ctx.focusWindowForTab).toHaveBeenCalled();
  });
  it("checks access immediately before close and reports the successful removal", async () => {
    await ctx.handler({ type: "closeTab", seq: 3, tabId: 7 });
    expect(ctx.requireAccessibleTab).toHaveBeenCalledExactlyOnceWith(7, ctx.epoch);
    expect(ctx.chromeMock.tabs.remove).toHaveBeenCalledWith(7);
    expect(ctx.detachDebugger).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith({ type: "result", seq: 3, result: {} });
  });
  it("does not report a post-operation result when access changes during CDP", async () => {
    const message = "tab 7 access was revoked";
    ctx.requireAccessibleTab
      .mockResolvedValueOnce({ id: 7, windowId: 3 })
      .mockRejectedValueOnce(new Error(message));
    await ctx.handler({ type: "cdp", seq: 4, tabId: 7, method: "Runtime.evaluate" });
    expect(ctx.send).toHaveBeenCalledWith({ type: "error", seq: 4, message });
  });
});
