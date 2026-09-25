import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupBackgroundHarnesses, loadRelayCommandHarness } from "./background.test-harness.js";

beforeEach(() => vi.resetModules());
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("relay input ordering", () => {
  it.each([
    { method: "Input.dispatchMouseEvent", types: ["mousePressed", "mouseReleased"] },
    { method: "Input.dispatchKeyEvent", types: ["keyDown", "char", "keyUp"] },
  ])("preserves $method wire order across asynchronous policy reads", async ({ method, types }) => {
    const h = await loadRelayCommandHarness("all");
    for (const tabId of [7, 8]) {
      expect(await h.command({ type: "attach", tabId })).toMatchObject({ type: "result" });
    }
    const gate = createDeferred<void>();
    const getTab = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementationOnce(async (id) => {
      await gate.promise;
      return getTab(id);
    });
    const inputs = types.map((type) =>
      h.command({ type: "cdp", tabId: 7, method, params: { type } }),
    );
    const observed = () =>
      h.debuggerSendCommand.mock.calls
        .filter(([target, name]) => target.tabId === 7 && name === method)
        .map((call) => call[2]?.type);
    let whileFirstReadPending: unknown[] = [];
    try {
      // An unrelated command and another tab must remain usable during the wait.
      for (const command of [
        { tabId: 7, method: "Runtime.evaluate", params: { expression: "1" } },
        { tabId: 8, method, params: { type: types[0] } },
      ]) {
        expect(await h.command({ type: "cdp", ...command })).toMatchObject({ type: "result" });
      }
      whileFirstReadPending = observed();
    } finally {
      gate.resolve();
      const results = await Promise.all(inputs);
      expect(results.every((result) => result.type === "result")).toBe(true);
    }
    expect(whileFirstReadPending).toEqual([]);
    expect(observed()).toEqual(types);
  });

  it("dispatches the next input without waiting for an earlier native result", async () => {
    const h = await loadRelayCommandHarness("all");
    expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
    const gate = createDeferred<Record<string, unknown>>();
    h.debuggerSendCommand.mockImplementationOnce(() => gate.promise);
    const press = h.command({
      type: "cdp",
      tabId: 7,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed" },
    });
    try {
      await vi.waitFor(() => expect(h.debuggerSendCommand).toHaveBeenCalledOnce());
      expect(
        await h.command({
          type: "cdp",
          tabId: 7,
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseReleased" },
        }),
      ).toMatchObject({ type: "result" });
    } finally {
      gate.resolve({});
      expect(await press).toMatchObject({ type: "result" });
    }
  });

  it("rejects queued input after its original debugger attachment is replaced", async () => {
    const h = await loadRelayCommandHarness("all");
    expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
    const gate = createDeferred<void>();
    const getTab = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementationOnce(async (id) => {
      await gate.promise;
      return getTab(id);
    });
    const commands = ["mousePressed", "mouseReleased"].map((type) =>
      h.command({ type: "cdp", tabId: 7, method: "Input.dispatchMouseEvent", params: { type } }),
    );
    try {
      expect(await h.command({ type: "detach", tabId: 7 })).toMatchObject({ type: "result" });
      expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
    } finally {
      gate.resolve();
      const results = await Promise.all(commands);
      expect(results).toEqual([
        expect.objectContaining({ type: "error", message: "Debugger attachment retired" }),
        expect.objectContaining({ type: "error", message: "Debugger attachment retired" }),
      ]);
    }
    expect(h.debuggerSendCommand).not.toHaveBeenCalled();
    expect(
      await h.command({
        type: "cdp",
        tabId: 7,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved" },
      }),
    ).toMatchObject({ type: "result" });
  });

  it("allows subsequent input after a policy lookup rejects the preceding command", async () => {
    const h = await loadRelayCommandHarness("all");
    expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
    h.tabsGet.mockRejectedValueOnce(new Error("Tab lookup failed"));
    const results = await Promise.all(
      ["mouseMoved", "mousePressed"].map((type) =>
        h.command({ type: "cdp", tabId: 7, method: "Input.dispatchMouseEvent", params: { type } }),
      ),
    );
    expect(results).toEqual([
      expect.objectContaining({ type: "error" }),
      expect.objectContaining({ type: "result" }),
    ]);
    expect(h.debuggerSendCommand).toHaveBeenCalledExactlyOnceWith(
      { tabId: 7 },
      "Input.dispatchMouseEvent",
      { type: "mousePressed" },
    );
  });
});
