import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupBackgroundHarnesses, loadRelayCommandHarness } from "./background.test-harness.js";

let h: Awaited<ReturnType<typeof loadRelayCommandHarness>>;
beforeEach(async () => {
  vi.resetModules();
  h = await loadRelayCommandHarness("all");
});
afterEach(async () => {
  await cleanupBackgroundHarnesses();
  vi.unstubAllGlobals();
});

const residency = () =>
  h.tabsUpdate.mock.calls
    .filter(([, change]) => "autoDiscardable" in change)
    .map(([tabId, change]) => [tabId, change.autoDiscardable]);
const ok = expect.objectContaining({ type: "result" });

it("keeps an attached tab out of Memory Saver until it is detached", async () => {
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  await vi.waitFor(() => expect(residency()).toEqual([[7, false]]));
  expect(await h.command({ type: "detach", tabId: 7 })).toEqual(ok);
  expect(residency()).toEqual([
    [7, false],
    [7, true],
  ]);
});

it("re-holds a tab that is attached again after a detach", async () => {
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  expect(await h.command({ type: "detach", tabId: 7 })).toEqual(ok);
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  await vi.waitFor(() =>
    expect(residency()).toEqual([
      [7, false],
      [7, true],
      [7, false],
    ]),
  );
});

it("leaves a tab that something else made non-discardable untouched", async () => {
  h.updateTab(7, { autoDiscardable: false }, false);
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  expect(await h.command({ type: "detach", tabId: 7 })).toEqual(ok);
  expect(residency()).toEqual([]);
});

it("restores residency when the user cancels the debugger", async () => {
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  await vi.waitFor(() => expect(residency()).toEqual([[7, false]]));
  h.debuggerDetachListener?.({ tabId: 7 }, "canceled_by_user");
  await vi.waitFor(() =>
    expect(residency()).toEqual([
      [7, false],
      [7, true],
    ]),
  );
});

it("still detaches when the tab is gone before residency can be restored", async () => {
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  await vi.waitFor(() => expect(residency()).toEqual([[7, false]]));
  h.tabsUpdate.mockRejectedValueOnce(new Error("No tab with id: 7."));
  expect(await h.command({ type: "detach", tabId: 7 })).toEqual(ok);
  expect(h.debuggerDetach).toHaveBeenCalled();
});

it("still attaches when Chrome refuses the residency change", async () => {
  h.tabsUpdate.mockRejectedValueOnce(new Error("No tab with id: 7."));
  expect(await h.command({ type: "attach", tabId: 7 })).toEqual(ok);
  expect(await h.command({ type: "detach", tabId: 7 })).toEqual(ok);
  expect(residency()).toEqual([[7, false]]);
});
