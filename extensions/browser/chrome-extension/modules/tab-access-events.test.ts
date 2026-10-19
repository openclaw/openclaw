import { describe, expect, it, vi } from "vitest";
import { chromeEvent, deferred } from "./browser.test-support.js";
import { registerTabAccessEvents } from "./tab-access-events.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

const makeEpoch = (revision = 0) => ({ revision, groupRevision: 0, tabRevision: 0 });

function createHarness(
  mode: "all" | "selected" = "selected",
  accessReady: Promise<unknown> = Promise.resolve(),
) {
  let revision = 0;
  let accessible = true;
  const attachments = new Map([[7, { epoch: makeEpoch() }]]);
  const send = vi.fn();
  const policy = {
    mode,
    observeTabUpdate: vi.fn(
      (_tabId: number, change: { url?: string; groupId?: number }) =>
        typeof change.url === "string" ||
        (mode === "selected" && typeof change.groupId === "number"),
    ),
    retireTab: vi.fn(() => {
      revision += 1;
    }),
    beginRevocation: vi.fn(() => Symbol("revocation")),
    endRevocation: vi.fn(),
    capture: vi.fn(() => makeEpoch(revision)),
    epochIsCurrent: vi.fn(
      (_tabId: number, epoch: { revision: number }) => epoch.revision === revision,
    ),
    invalidateTab: vi.fn(() => {
      revision += 1;
    }),
    renewTabAccess: vi.fn(() => {
      revision += 1;
      return makeEpoch(revision);
    }),
    forwardDocumentEvent: vi.fn((event, emit) => emit(event)),
    invalidateGroup: vi.fn(() => {
      revision += 1;
      return true;
    }),
    inspectTab: vi.fn(async (_tabId: number, epoch: { revision: number }) => ({
      accessible: accessible && epoch.revision === revision,
    })),
    listAccessibleTabs: vi.fn(async () => (accessible ? [{ id: 7 }] : [])),
    forgetTab: vi.fn(async () => undefined),
    replaceTab: vi.fn(async () => false),
  };
  const detachDebugger = vi.fn(async (tabId: number) => {
    attachments.delete(tabId);
  });
  const pauseTab = vi.fn(async () => undefined);
  const removeTabFromOpenClawGroup = vi.fn(async () => undefined);
  const chromeApi = {
    debugger: {
      onEvent: chromeEvent<[source: { tabId?: number }, method: string, params: unknown]>(),
      onDetach: chromeEvent<[source: { tabId?: number }, reason: string]>(),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onReplaced: chromeEvent<[addedTabId: number, removedTabId: number]>(),
      onUpdated: chromeEvent<[number, { groupId?: number; url?: string }, BrowserTabSnapshot]>(),
    },
    tabGroups: {
      onUpdated: chromeEvent<[group?: { id: number; title?: string }]>(),
      onRemoved: { addListener: vi.fn() },
    },
  };

  registerTabAccessEvents({
    chromeApi,
    accessReady,
    policy,
    attachments,
    nativeDetached: (tabId: number) => attachments.delete(tabId),
    send,
    scheduleTabsSync: vi.fn(),
    detachDebugger,
    pauseTab,
    removeTabFromOpenClawGroup,
    runAccessMutation: vi.fn(async (task) => await task()),
  });
  return {
    attachments,
    detachDebugger,
    debuggerDetachListener: chromeApi.debugger.onDetach.emit,
    debuggerEventListener: chromeApi.debugger.onEvent.emit,
    groupUpdatedListener: chromeApi.tabGroups.onUpdated.emit,
    policy,
    pauseTab,
    removeTabFromOpenClawGroup,
    send,
    setAccessible: (next: boolean) => {
      accessible = next;
    },
    tabsUpdatedListener: (tabId: number, changeInfo: { groupId?: number; url?: string }) =>
      chromeApi.tabs.onUpdated.emit(tabId, changeInfo, { id: tabId, ...changeInfo }),
    tabsReplacedListener: chromeApi.tabs.onReplaced.emit,
  };
}

async function overlapUpdates(
  h: ReturnType<typeof createHarness>,
  url: string,
  accessible: boolean,
) {
  const first = deferred<{ accessible: boolean }>();
  let resumed = false;
  h.policy.inspectTab
    .mockImplementationOnce(async () => {
      const state = await first.promise;
      resumed = true;
      return state;
    })
    .mockResolvedValueOnce({ accessible });
  h.tabsUpdatedListener(7, { url: "https://one.example" });
  await vi.waitFor(() => expect(h.policy.inspectTab).toHaveBeenCalledTimes(1));
  h.tabsUpdatedListener(7, { url });
  return async () => {
    first.resolve({ accessible: false });
    await vi.waitFor(() => expect(resumed).toBe(true));
    await Promise.resolve();
  };
}

describe("tab access event epochs", () => {
  it("waits for stored access mode before handling Chrome's cancel revocation", async () => {
    const ready = deferred<void>();
    const h = createHarness("selected", ready.promise);

    h.debuggerDetachListener({ tabId: 7 }, "canceled_by_user");
    expect(h.policy.beginRevocation).toHaveBeenCalledWith(7);
    expect(h.pauseTab).not.toHaveBeenCalled();
    expect(h.removeTabFromOpenClawGroup).not.toHaveBeenCalled();

    h.policy.mode = "all";
    ready.resolve();
    await vi.waitFor(() => expect(h.pauseTab).toHaveBeenCalledWith(7));

    expect(h.removeTabFromOpenClawGroup).not.toHaveBeenCalled();
    expect(h.policy.endRevocation).toHaveBeenCalledOnce();
  });

  it("ignores a stale URL revocation after a newer eligible update", async () => {
    const h = createHarness("all");
    const resume = await overlapUpdates(h, "https://two.example", true);
    await vi.waitFor(() => expect(h.attachments.get(7)?.epoch).toEqual(makeEpoch(2)));

    await resume();

    expect(h.detachDebugger).not.toHaveBeenCalled();
    h.debuggerEventListener({ tabId: 7 }, "Runtime.consoleAPICalled", {});
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: "cdpEvent", tabId: 7 }));
  });

  it("lets the current restricted URL update revoke exactly once when an older update resumes", async () => {
    const h = createHarness("all");
    const resume = await overlapUpdates(h, "chrome://settings", false);
    await vi.waitFor(() => expect(h.detachDebugger).toHaveBeenCalledTimes(1));
    await resume();

    expect(h.detachDebugger).toHaveBeenCalledTimes(1);
  });

  it("cleans up both tab identities after Chrome replaces a paused tab", async () => {
    const h = createHarness("all");
    h.policy.replaceTab.mockResolvedValueOnce(true);

    h.tabsReplacedListener(8, 7);

    await vi.waitFor(() => {
      expect(h.policy.replaceTab).toHaveBeenCalledWith(8, 7);
      expect(h.detachDebugger).toHaveBeenCalledWith(7);
      expect(h.detachDebugger).toHaveBeenCalledWith(8);
    });
  });

  it("does not refresh epochs from a stale group-wide access snapshot", async () => {
    const h = createHarness();
    const firstList = deferred<Array<{ id: number }>>();
    h.policy.listAccessibleTabs
      .mockImplementationOnce(async () => await firstList.promise)
      .mockResolvedValueOnce([{ id: 7 }]);

    h.groupUpdatedListener();
    await vi.waitFor(() => expect(h.policy.listAccessibleTabs).toHaveBeenCalledTimes(1));
    h.groupUpdatedListener();
    await vi.waitFor(() => expect(h.policy.listAccessibleTabs).toHaveBeenCalledTimes(2));
    h.setAccessible(false);
    h.policy.invalidateTab();
    firstList.resolve([{ id: 7 }]);
    await Promise.resolve();

    h.debuggerEventListener({ tabId: 7 }, "Network.requestWillBeSent", {});
    expect(h.send).not.toHaveBeenCalled();
  });
});
