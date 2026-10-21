import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp, holdNext } from "./background.lifecycle-test-helpers.js";
import { cleanupBackgroundHarnesses, loadRelayCommandHarness } from "./background.test-harness.js";

let h: Awaited<ReturnType<typeof loadRelayCommandHarness>>;
beforeEach(async () => {
  vi.resetModules();
  h = await loadRelayCommandHarness("all");
  expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
});
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mouse = "Input.dispatchMouseEvent";
const key = "Input.dispatchKeyEvent";
const input = (type: string, method = mouse, tabId = 7) =>
  h.command({ type: "cdp", tabId, method, params: { type } });

function deferPolicyRead() {
  const gate = createDeferred<void>();
  holdNext(h.tabsGet, gate.promise);
  return gate;
}
const result = expect.objectContaining({ type: "result" });
const retired = expect.objectContaining({ type: "error", message: "Debugger attachment retired" });

it("preserves mixed input wire order across asynchronous policy reads", async () => {
  expect(await h.command({ type: "attach", tabId: 8 })).toMatchObject({ type: "result" });
  const gate = deferPolicyRead();
  const events: [string, string][] = [
    [mouse, "mousePressed"],
    [key, "keyDown"],
    [key, "char"],
    [key, "keyUp"],
    [mouse, "mouseReleased"],
  ];
  const inputs = events.map(([method, type]) => input(type, method));
  const observed = () =>
    h.debuggerSendCommand.mock.calls
      .filter(([target, name]) => target.tabId === 7 && name.startsWith("Input."))
      .map(([, method, params]) => [method, params?.type]);
  try {
    // An unrelated command and another tab must remain usable during the wait.
    expect(await h.command(cdp("Runtime.evaluate", { expression: "1" }, 7))).toEqual(result);
    expect(await input("mousePressed", mouse, 8)).toEqual(result);
    expect(observed()).toEqual([]);
  } finally {
    gate.resolve();
    expect(await Promise.all(inputs)).toEqual(events.map(() => result));
  }
  expect(observed()).toEqual(events);
});

it("dispatches the next input without waiting for an earlier native result", async () => {
  const gate = createDeferred<Record<string, unknown>>();
  h.debuggerSendCommand.mockImplementationOnce(() => gate.promise);
  const press = input("mousePressed");
  try {
    await vi.waitFor(() => expect(h.debuggerSendCommand).toHaveBeenCalledOnce());
    expect(await input("mouseReleased")).toMatchObject({ type: "result" });
  } finally {
    gate.resolve({});
    expect(await press).toMatchObject({ type: "result" });
  }
});

it("rejects queued input after its original debugger attachment is replaced", async () => {
  const gate = deferPolicyRead();
  const commands = ["mousePressed", "mouseReleased"].map((type) => input(type));
  try {
    expect(await h.command({ type: "detach", tabId: 7 })).toMatchObject({ type: "result" });
    expect(await h.command({ type: "attach", tabId: 7 })).toMatchObject({ type: "result" });
  } finally {
    gate.resolve();
    expect(await Promise.all(commands)).toEqual([retired, retired]);
  }
  expect(h.debuggerSendCommand).not.toHaveBeenCalled();
  expect(await input("mouseMoved")).toMatchObject({ type: "result" });
});

it("allows subsequent input after a policy lookup rejects the preceding command", async () => {
  h.tabsGet.mockRejectedValueOnce(new Error("Tab lookup failed"));
  const results = await Promise.all(["mouseMoved", "mousePressed"].map((type) => input(type)));
  expect(results).toEqual([expect.objectContaining({ type: "error" }), result]);
  expect(h.debuggerSendCommand).toHaveBeenCalledExactlyOnceWith({ tabId: 7 }, mouse, {
    type: "mousePressed",
  });
});
