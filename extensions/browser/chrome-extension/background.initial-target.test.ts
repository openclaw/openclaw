import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import {
  cdp,
  connectCdpClient,
  connectExtension,
  createTab,
  deferredScope,
  expectType,
  expectResult,
  expectUnused,
  relayConfig,
  runtime,
  waitCalled,
  type CdpFrame as Frame,
} from "./background.lifecycle-test-helpers.js";
import {
  cleanupBackgroundHarnesses,
  loadBackground,
  loadRelayCommandHarness as createHarness,
} from "./background.test-harness.js";
const { deferred, releaseAll } = deferredScope();
const releases: Array<() => void> = [];
type Harness = Awaited<ReturnType<typeof createHarness>>;
const revoke = {
  cancel: (h: Harness) => h.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user"),
  group: (h: Harness) => h.updateTab(101, { groupId: -1 }),
  replacement: (h: Harness) => h.tabsReplacedListener(102, 101),
  removal: (h: Harness) => h.tabsRemovedListener?.(101),
};
function createdProperties(h: Harness, properties: Record<string, unknown>) {
  const create = h.tabsCreate.getMockImplementation()!;
  h.tabsCreate.mockImplementation(async (params) =>
    Object.assign(await create(params), properties),
  );
}
async function heldCreation(h: Harness, stage: "attach" | "group" = "attach") {
  const completion = deferred(undefined);
  const mock = stage === "attach" ? h.debuggerAttach : h.tabGroupsUpdate;
  mock.mockImplementationOnce(() => completion.promise);
  const result = h.command(createTab());
  await waitCalled(mock);
  return { result, finish: completion.resolve };
}
async function heldCommand(h: Harness, message: Record<string, unknown>) {
  const completion = deferred({});
  h.debuggerSendCommand.mockImplementationOnce(() => completion.promise);
  const result = h.command(message);
  await waitCalled(h.debuggerSendCommand);
  return { result, finish: completion.resolve };
}
beforeEach(() => vi.resetModules());
afterEach(async () => {
  vi.restoreAllMocks();
  releases.splice(0).forEach((release) => release());
  releaseAll();
  await cleanupBackgroundHarnesses();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.doUnmock("./modules/tab-access.js");
  vi.unstubAllGlobals();
});

describe("created initial target in selected mode", () => {
  const mode = "selected";
  it("does not reclaim redirected HTTP creation after attachment fails", async () => {
    const h = await createHarness(mode);
    createdProperties(h, { url: "", pendingUrl: "https://example.com/start" });
    const group = h.tabsGroup.getMockImplementation()!;
    h.tabsGroup.mockImplementationOnce(async (params) => {
      h.updateTab(101, { url: "https://example.com/redirected", pendingUrl: undefined });
      return await group(params);
    });
    h.debuggerAttach.mockRejectedValueOnce(new Error("attach failed"));
    expectType(await h.command(createTab("https://example.com/start")), "error");
    expect(h.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
    expectUnused(h.tabsRemove);
  });
  it("retires an unhanded blank when a lookup observes takeover before the URL event", async () => {
    const h = await createHarness(mode);
    const creating = await heldCreation(h);
    const get = h.tabsGet.getMockImplementation()!;
    h.tabsGet.mockImplementation(async (tabId) => ({
      ...(await get(tabId)),
      url: "https://example.com/user-takeover",
    }));
    await runtime(h, "getTabAccess", { tabId: 101 });
    h.updateTab(101, { url: "https://example.com/user-takeover" });
    creating.finish();
    expectType(await creating.result, "error");
    expectUnused(h.tabsRemove);
  });
  it.each(["Chrome query", "completed policy read"])(
    "survives a stale %s after blank-target creation",
    async (phase) => {
      let inspecting = false;
      let holdSnapshot = false;
      const inventory = deferred(undefined);
      if (phase === "completed policy read") {
        vi.doMock("./modules/tab-access.js", async (importOriginal) => {
          const actual = await importOriginal<typeof import("./modules/tab-access.js")>();
          return {
            ...actual,
            createTabAccessPolicy: (...args: Parameters<typeof actual.createTabAccessPolicy>) => {
              const policy = actual.createTabAccessPolicy(...args);
              const list = policy.listAccessibleTabs.bind(policy);
              policy.listAccessibleTabs = async (...listArgs) => {
                const snapshot = await list(...listArgs);
                if (holdSnapshot) {
                  holdSnapshot = false;
                  inspecting = true;
                  await inventory.promise;
                }
                return snapshot;
              };
              return policy;
            },
          };
        });
      }
      const h = await createHarness(mode);
      h.tabGroupsQuery.mockResolvedValue([{ id: 7, windowId: 1 }]);
      const bridge = new ExtensionRelayBridge();
      connectExtension(bridge, h);
      const client = connectCdpClient(bridge);
      const request = client.requestResult;
      try {
        await request("Target.setAutoAttach", { autoAttach: true, flatten: true });
        const staleTabs = await h.tabsQuery();
        if (phase === "Chrome query") {
          h.tabsQuery.mockImplementationOnce(async () => {
            inspecting = true;
            await inventory.promise;
            return staleTabs;
          });
        } else {
          // Hold the real completed read at the await boundary before publication.
          holdSnapshot = true;
        }
        h.updateTab(100, { url: "about:blank" });
        await vi.waitFor(() => expect(inspecting).toBe(true));
        expect(await request("Target.createTarget", { url: "about:blank" })).toEqual({
          targetId: "tab-101",
        });
        const sessionId = client.root("tab-101");
        expect(sessionId).toBeTruthy();
        const inventoryCount = h.frames().filter((frame) => frame.type === "tabs").length;
        inventory.resolve();
        await vi.waitFor(() =>
          expect(h.frames().filter((frame) => frame.type === "tabs").length).toBeGreaterThan(
            inventoryCount,
          ),
        );
        await request("Page.enable", {}, sessionId);
        h.debuggerSendCommand.mockImplementationOnce(async () => {
          h.updateTab(101, { url: "https://example.com/" });
          return { frameId: "frame-101", loaderId: "next-document" };
        });
        await request("Page.navigate", { url: "https://example.com/" }, sessionId);
        await request("Runtime.evaluate", { expression: "document.title" }, sessionId);
        await request("Target.detachFromTarget", { sessionId });
        expect(await request("Target.closeTarget", { targetId: "tab-101" })).toEqual({
          success: true,
        });
        expect(h.debuggerAttach).toHaveBeenCalledExactlyOnceWith({ tabId: 101 }, "1.3");
        expect(h.tabsRemove).toHaveBeenCalledExactlyOnceWith(101);
      } finally {
        await client.close();
        bridge.dispose();
      }
    },
  );
  it.each([{ pendingUrl: "chrome://settings" }, { incognito: true }])(
    "does not grant initial ownership over a restricted created tab: %j",
    async (properties) => {
      const h = await createHarness(mode);
      createdProperties(h, properties);
      expectType(await h.command(createTab()), "error");
      expectUnused(h.debuggerAttach);
      expectType(await h.command({ type: "attach", tabId: 100 }), "error");
    },
  );
  it.each(["matching", "different"])(
    "checks a lagging blank snapshot against a %s pending URL",
    async (pending) => {
      const h = await createHarness(mode);
      await h.command(createTab());
      const url = "https://example.com/destination";
      const result = { frameId: "frame-101", loaderId: "destination" };
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(
          101,
          { pendingUrl: pending === "matching" ? url : "https://example.com/other" },
          false,
        );
        const getGroup = h.tabGroupsGet.getMockImplementation()!;
        // Commit between the two access reads, before Chrome's tab snapshot catches up.
        h.tabGroupsGet.mockImplementationOnce(async (groupId) => {
          h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
            frame: { id: result.frameId, loaderId: result.loaderId, url },
          });
          return await getGroup(groupId);
        });
        return result;
      });
      const response = await h.command(cdp("Page.navigate", { url }));
      if (pending !== "matching") {
        expectType(response, "error");
        return;
      }
      expectResult(response, result);
      h.updateTab(100, { title: "Trigger discovery" });
      await vi.waitFor(() =>
        expect(h.frames().findLast((frame) => frame.type === "tabs")?.tabs).toContainEqual(
          expect.objectContaining({ tabId: 101, url }),
        ),
      );
      expectUnused(h.debuggerDetach);
      h.updateTab(101, { url, pendingUrl: undefined });
      expectType(await h.command(cdp("Runtime.evaluate")));
      h.updateTab(101, { url: "about:blank" });
      expectType(await h.command({ type: "attach", tabId: 101 }), "error");
      expectType(await h.command({ type: "closeTab", tabId: 101 }), "error");
      expectUnused(h.tabsRemove);
    },
  );
  it("fences commands and events immediately on a restricted pending destination", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    const executing = await heldCommand(h, cdp("Runtime.evaluate"));
    h.updateTab(101, { pendingUrl: "chrome://settings" });
    h.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", {});
    expect(h.frames().some((frame) => frame.type === "cdpEvent")).toBe(false);
    executing.finish();
    expectType(await executing.result, "error");
    expectType(await h.command({ type: "attach", tabId: 101 }), "error");
  });
  it("finishes bootstrap when Chrome commits the original pending blank after handoff", async () => {
    const h = await createHarness(mode);
    createdProperties(h, { url: "", pendingUrl: "about:blank" });
    expectType(await h.command(createTab()));
    const initializing = await heldCommand(h, cdp("Page.enable"));
    h.updateTab(101, { url: "about:blank", pendingUrl: undefined });
    initializing.finish();
    expectType(await initializing.result);
    expectType(await h.command({ type: "closeTab", tabId: 101 }));
  });
  it.each([true, false])("handles late self-group naming after revocation: %s", async (revoked) => {
    const h = await createHarness(mode);
    if (!revoked) {
      h.tabGroupsUpdate.mockResolvedValueOnce(undefined);
    }
    const creating = await heldCreation(h, revoked ? "group" : "attach");
    if (revoked) {
      await runtime(h, "toggleTabAccess", { tabId: 101, accessMode: mode, grant: false });
    }
    h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
    creating.finish();
    expectType(await creating.result, revoked ? "error" : "result");
    expectUnused(h.tabsRemove);
    if (revoked) {
      expectUnused(h.debuggerAttach);
    }
  });
  it("keeps Pause/Allow or selected-group regrant coherent for the same initial document", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    for (const grant of [false, true]) {
      expect(
        await runtime(h, "toggleTabAccess", { tabId: 101, accessMode: mode, grant }),
      ).toMatchObject({ ok: true, accessible: grant });
      expectType(await h.command({ type: "attach", tabId: 101 }), grant ? "result" : "error");
    }
  });
  it.each(["pause", "cancel", "group", "replacement", "removal"] as const)(
    "fences an in-flight creation after %s without rolling back a taken-over tab",
    async (revocation) => {
      const h = await createHarness(mode);
      const creating = await heldCreation(h);
      let mutation: Promise<unknown> | undefined;
      if (revocation === "pause") {
        mutation = runtime(h, "toggleTabAccess", { tabId: 101, accessMode: mode, grant: false });
        await vi.waitFor(async () =>
          expect(await runtime(h, "getTabAccess", { tabId: 101 })).toMatchObject({
            accessible: false,
          }),
        );
      } else {
        revoke[revocation](h);
        if (revocation === "replacement" || revocation === "removal") {
          // A copied/reused snapshot must not restore authority after the event.
          h.updateTab(revocation === "replacement" ? 102 : 101, { url: "about:blank", groupId: 7 });
        }
      }
      creating.finish();
      expectType(await creating.result, "error");
      await mutation;
      expectUnused(h.tabsRemove);
      if (revocation === "cancel") {
        // Chrome's onDetach already destroyed this exact native client.
        expectUnused(h.debuggerDetach);
      } else {
        expect(h.debuggerDetach).toHaveBeenCalledWith({ targetId: "tab-101" });
      }
      if (revocation === "replacement") {
        expectType(await h.command({ type: "attach", tabId: 102 }), "error");
      }
    },
  );
  it("does not restore initial provenance from group snapshots after worker restart", async () => {
    const h = await createHarness(mode);
    await h.command(createTab());
    const initialTabs = await h.tabsQuery();
    await cleanupBackgroundHarnesses();
    vi.resetModules();
    const restarted = await loadBackground({
      storedConfig: { ...h.storageValues, ...relayConfig(mode) },
      initialTabs,
    });
    expect(await runtime(restarted, "getTabAccess", { tabId: 101 })).toMatchObject({
      accessible: false,
      eligible: false,
    });
  });
  it("preserves the original failure and reports failed rollback", async () => {
    const h = await createHarness(mode);
    h.tabsGroup.mockRejectedValueOnce(new Error("group failed"));
    h.tabsRemove.mockRejectedValueOnce(new Error("remove failed"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await h.command(createTab())).toMatchObject({
      type: "error",
      message: "group failed; cleanup failed for created tab 101; close it manually.",
    });
    expect(warning).toHaveBeenCalledWith("Cleanup failed for created tab 101; close it manually.");
  });
});

const url = "https://example.com/destination";
const navigation = { frameId: "main", loaderId: "destination" };
const navigationEvent = { frame: { id: "main", loaderId: "destination", url } };
const revokedMessage = expect.stringMatching(
  /access was revoked|restricted or unavailable|Debugger attachment retired/,
);
function expectError(response: unknown, message: unknown) {
  expect(response).toMatchObject({ type: "error", message });
}
async function createdTarget() {
  const h = await createHarness("selected");
  expectType(await h.command({ ...createTab(), background: true }));
  return h;
}
it("retires stale page data across a reload without a URL change", async () => {
  const h = await createHarness("selected");
  await h.command(createTab("https://example.com/same"));
  const reading = await heldCommand(h, cdp("Runtime.evaluate"));
  h.updateTab(101, { status: "loading" });
  reading.finish();
  expectType(await reading.result, "error");
});

describe("physical tab creation authority", () => {
  it.each(["initial blank", "committed then blank", "removed"] as const)(
    "honors %s observed before tabs.create resolves",
    async (observation) => {
      const h = await createHarness("all");
      const create = h.tabsCreate.getMockImplementation()!;
      h.tabsCreate.mockImplementationOnce(async (properties) => {
        const tab = await create(properties);
        if (observation === "initial blank") {
          h.updateTab(tab.id, { url: "about:blank" });
        } else if (observation === "committed then blank") {
          h.updateTab(tab.id, { url: "https://example.com/committed" });
          h.updateTab(tab.id, { url: "about:blank" }, false);
        } else {
          h.tabsRemovedListener?.(tab.id);
        }
        return tab;
      });
      expectType(
        await h.command(createTab()),
        observation === "initial blank" ? "result" : "error",
      );
      expectUnused(h.tabsRemove);
    },
  );
  it("keeps an HTTP creation revoked after group removal and restoration before its callback", async () => {
    const h = await createHarness("selected");
    const create = h.tabsCreate.getMockImplementation()!;
    h.tabsCreate.mockImplementationOnce(async (properties) => {
      const tab = await create(properties);
      for (const groupId of [7, -1, 7]) {
        h.updateTab(tab.id, { groupId });
      }
      return tab;
    });
    expect(await h.command(createTab("https://example.com/destination"))).toMatchObject({
      type: "error",
      message: "created tab is no longer available",
    });
    expectUnused(h.debuggerAttach, h.tabsRemove);
  });
  it.each(["initial loading snapshot", "same-group update"] as const)(
    "preserves navigation with a late %s",
    async (event) => {
      const h = await createdTarget();
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        h.updateTab(101, { pendingUrl: url }, false);
        const initialLoadingTab = await h.tabsGet(101);
        h.updateTab(101, { url, pendingUrl: undefined }, false);
        h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", navigationEvent);
        if (event === "initial loading snapshot") {
          h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
        } else {
          const tab = { ...initialLoadingTab, url, pendingUrl: undefined };
          h.tabsUpdatedListener?.(101, { groupId: tab.groupId }, tab);
        }
        return { ...navigation };
      });
      expectResult(await h.command(cdp("Page.navigate", { url })), navigation);
      expectUnused(h.debuggerDetach);
    },
  );
  it("keeps loading-snapshot authority revoked after group removal and restoration", async () => {
    const h = await createdTarget();
    const initialLoadingTab = { ...(await h.tabsGet(101)), pendingUrl: url };
    h.updateTab(101, { url }, false);
    h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", navigationEvent);
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.updateTab(101, { groupId: -1 });
      h.updateTab(101, { groupId: 7 });
      h.tabsUpdatedListener?.(101, { status: "loading" }, initialLoadingTab);
      return { ...navigation };
    });
    expectError(await h.command(cdp("Page.navigate", { url })), revokedMessage);
    expect(h.debuggerSendCommand).toHaveBeenCalledWith({ tabId: 101 }, "Page.navigate", { url });
  });
  it("restores fresh attachment authority without reviving a command admitted before a title change", async () => {
    const h = await createHarness("selected");
    h.tabGroupsUpdate.mockResolvedValueOnce(undefined);
    await h.command({ ...createTab(), background: true });
    expectType(await h.command({ type: "attach", tabId: 101 }));
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      h.tabGroupUpdatedListener?.({ id: 7, title: "Other" });
      h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
      return { frameId: "main" };
    });
    expectError(
      await h.command(cdp("Page.navigate", { url })),
      expect.stringContaining("access was revoked"),
    );
    await vi.waitFor(() => {
      h.debuggerEventListener?.({ tabId: 101 }, "Runtime.consoleAPICalled", { value: 1 });
      expect(h.frames()).toContainEqual(
        expect.objectContaining({ type: "cdpEvent", method: "Runtime.consoleAPICalled" }),
      );
    });
    expectType(await h.command(cdp("Runtime.enable")));
  });
  it.each(["removal", "lookup"])(
    "revokes creation when group %s beats its callback",
    async (event) => {
      const h = await createHarness("selected");
      h.tabGroupsUpdate.mockImplementationOnce(async () => {
        if (event === "removal") {
          h.tabGroupUpdatedListener?.({ id: 7, title: "OpenClaw" });
          h.tabGroupRemovedListener?.({ id: 7, title: "OpenClaw" });
        } else {
          h.tabGroupsGet.mockResolvedValue({ id: 7, title: "Other", windowId: 1 });
        }
      });
      expectType(await h.command(createTab()), "error");
      expectUnused(h.tabsRemove);
    },
  );
  it.each(["removed", "pause"] as const)(
    "rechecks %s after the failure-cleanup lookup yields",
    async (reason) => {
      const h = await createHarness("all");
      const lookup = createDeferred<Awaited<ReturnType<typeof h.tabsGet>>>();
      let inspectingCleanup = false;
      h.debuggerAttach.mockImplementationOnce(async () => {
        const tab = await h.tabsGet(101);
        releases.push(() => lookup.resolve(tab));
        h.tabsGet.mockImplementationOnce(async () => {
          inspectingCleanup = true;
          return await lookup.promise;
        });
        throw new Error("attach failed");
      });
      const attaching = h.command(createTab());
      await vi.waitFor(() => expect(inspectingCleanup).toBe(true));
      let pausing: Promise<unknown> | undefined;
      if (reason === "removed") {
        h.tabsRemovedListener?.(101);
      } else {
        pausing = runtime(h, "toggleTabAccess", { accessMode: "all", tabId: 101, grant: false });
        await vi.waitFor(() => expect(h.sessionStorageValues.deniedTabIdsV1).toEqual([101]));
      }
      lookup.resolve(await h.tabsGet(101));
      await pausing;
      expectError(await attaching, "attach failed");
      expectUnused(h.tabsRemove);
    },
  );
  it("fences a selected revoke while grouping and leaves the user tab alone", async () => {
    const h = await createHarness("selected");
    const pendingGroup = createDeferred<number>();
    releases.push(() => pendingGroup.resolve(7));
    const group = h.tabsGroup.getMockImplementation()!;
    h.tabsGroup.mockImplementationOnce(async (properties) => {
      await group(properties);
      return await pendingGroup.promise;
    });
    const creating = h.command({ ...createTab(), focus: true });
    await waitCalled(h.tabsGroup);
    expect(
      await runtime(h, "toggleTabAccess", { accessMode: "selected", tabId: 101, grant: false }),
    ).toMatchObject({ ok: true });
    pendingGroup.resolve(7);
    expectError(await creating, expect.stringMatching(/revoked/));
    expectUnused(h.windowsUpdate, h.tabsRemove);
    expectType(await h.command({ type: "attach", tabId: 101 }), "error");
  });
});

type FetchOperation = {
  method: string;
  stage?: "response" | "auth";
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
const continueRequest: FetchOperation = { method: "Fetch.continueRequest" };
const targetId = "tab-101";
const authContinuation: FetchOperation = {
  method: "Fetch.continueWithAuth",
  stage: "auth",
  params: { authChallengeResponse: { response: "Default" } },
};
const bodyRead: FetchOperation = {
  method: "Fetch.takeResponseBodyAsStream",
  stage: "response",
  result: { stream: "native-body" },
};
const cleanups: Array<() => Promise<void>> = [];
async function setupTarget(operation = continueRequest) {
  const harness = await createHarness("selected");
  const bridge = new ExtensionRelayBridge();
  connectExtension(bridge, harness, true);
  const owner = connectCdpClient(bridge);
  const observer = connectCdpClient(bridge);
  cleanups.push(async () => {
    await Promise.all([owner.close(), observer.close()]);
    bridge.dispose();
  });
  for (const client of [owner, observer]) {
    expect(
      await client.request("Target.setAutoAttach", { autoAttach: true, flatten: true }),
    ).toMatchObject({ result: {} });
  }
  expect(await owner.requestResult("Target.createTarget", { url: "about:blank" })).toEqual({
    targetId,
  });
  const session = owner.root(targetId);
  const observerSession = observer.root(targetId);
  const target = bridge.captureOperationTarget(targetId);
  assert(target);
  return { harness, bridge, owner, observer, session, observerSession, target, operation };
}

async function setup(operation = continueRequest) {
  const rig = await setupTarget(operation);
  const { harness, owner, observer, session, observerSession, target } = rig;
  expect(await owner.request("Fetch.enable", { handleAuthRequests: true }, session)).toMatchObject({
    result: {},
  });
  const event = operation.stage === "auth" ? "Fetch.authRequired" : "Fetch.requestPaused";
  harness.debuggerEventListener?.({ tabId: 101 }, event, {
    requestId: "native-navigation-request",
    ...(operation.stage === "response" ? { responseStatusCode: 200 } : {}),
  });
  const requestId = owner.events(event).at(-1)?.params?.requestId;
  assert(typeof requestId === "string");
  assert.notEqual(requestId, "native-navigation-request");
  expect(observer.events(event)).toEqual([]);
  const params: Record<string, unknown> = { ...operation.params, requestId };
  const beforeForeign = harness.debuggerSendCommand.mock.calls.length;
  expect(await observer.request(operation.method, params, observerSession)).toMatchObject({
    error: { message: expect.stringContaining("another session") },
  });
  expect(harness.debuggerSendCommand.mock.calls).toHaveLength(beforeForeign);
  expect(target()).toBe(targetId);
  return { ...rig, params };
}

async function setupConfiguration(method: string) {
  const rig = await setupTarget({ method });
  if (method === "Fetch.disable") {
    expect(await rig.owner.request("Fetch.enable", {}, rig.session)).toMatchObject({ result: {} });
  }
  return { ...rig, params: {} };
}

async function holdNativeCompletion(rig: Awaited<ReturnType<typeof setup>>) {
  const started = deferred(undefined);
  const completed = deferred(undefined);
  const native = rig.harness.debuggerSendCommand.getMockImplementation()!;
  rig.harness.debuggerSendCommand.mockImplementation(async (source, method, params) => {
    if (method !== rig.operation.method) {
      return await native(source, method, params);
    }
    expect(params).toEqual(
      Object.hasOwn(rig.params, "requestId")
        ? { ...rig.params, requestId: "native-navigation-request" }
        : rig.params,
    );
    started.resolve();
    await completed.promise;
    return rig.operation.result ?? {};
  });
  const id = rig.owner.send(rig.operation.method, rig.params, rig.session);
  await started.promise;
  return { id, complete: completed.resolve };
}

function commitAllowed(h: Harness) {
  h.updateTab(101, { url, pendingUrl: undefined });
  h.debuggerEventListener?.({ tabId: 101 }, "Page.frameNavigated", {
    frame: {
      id: "frame-101",
      url,
      loaderId: "destination-loader",
    },
  });
  h.debuggerEventListener?.({ tabId: 101 }, "Page.lifecycleEvent", {
    name: "load",
    frameId: "frame-101",
  });
}

function nativeCalls(rig: Awaited<ReturnType<typeof setup>>) {
  return rig.harness.debuggerSendCommand.mock.calls.filter(
    ([, method]) => method === rig.operation.method,
  );
}

async function assertReceiptAndContinuity(rig: Awaited<ReturnType<typeof setup>>, response: Frame) {
  expect.soft(response).toMatchObject({ result: {} });
  expect.soft(response.error).toBeUndefined();
  expect.soft(rig.target()).toBe(targetId);
  for (const [client, session] of [
    [rig.owner, rig.session],
    [rig.observer, rig.observerSession],
  ] as const) {
    expect.soft(await client.requestResult("Page.getFrameTree", {}, session)).toEqual({});
    const detached = client
      .events("Target.detachedFromTarget")
      .filter((frame) => frame.params?.targetId === targetId);
    expect.soft(detached).toHaveLength(0);
  }
  expect(nativeCalls(rig)).toHaveLength(1);
}
async function completeAcrossCommit(
  rig: Awaited<ReturnType<typeof setup>>,
  order: string,
  pending?: () => Promise<void>,
) {
  const held = await holdNativeCompletion(rig);
  if (pending) {
    await pending();
  }
  if (order === "commit-first") {
    commitAllowed(rig.harness);
  }
  held.complete();
  const response = await rig.owner.response(held.id);
  if (order === "completion-first") {
    commitAllowed(rig.harness);
  }
  await assertReceiptAndContinuity(rig, response);
}
// The native completion is the only fault-injected boundary. Real background
// policy, Fetch lease/pause ownership, and both logical relay sessions participate.
describe("tab-scoped relay completions", () => {
  it("rejects disable with an unresolved streamed response without retiring its owner", async () => {
    const rig = await setup(bodyRead);
    const held = await holdNativeCompletion(rig);
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response).toMatchObject({
      result: { stream: expect.stringMatching(/^openclaw-fetch-stream:/) },
    });
    expect(await rig.owner.request("Fetch.disable", {}, rig.session)).toMatchObject({
      error: { message: expect.stringContaining("streamed responses") },
    });
    expect(
      rig.harness.debuggerSendCommand.mock.calls.filter(([, method]) => method === "Fetch.disable"),
    ).toHaveLength(0);
    await assertReceiptAndContinuity(rig, response);
  });
  it.each([
    ["Network.setCacheDisabled", "all", { cacheDisabled: true }, "result"],
    ["Network.setCacheDisabled", "selected", { cacheDisabled: true }, "result"],
    ["Network.setExtraHTTPHeaders", "selected", { headers: { "X-Test": "synthetic" } }, "result"],
    ["Network.setBypassServiceWorker", "selected", { bypass: true }, "result"],
    ["Network.getResponseBody", "selected", { requestId: "synthetic" }, "error"],
    ["Fetch.getResponseBody", "selected", { requestId: "synthetic" }, "error"],
  ] as const)(
    "settles native %s across a commit in %s mode",
    async (method, mode, params, type) => {
      const h = await createHarness(mode);
      expectType(await h.command(createTab("https://example.com/source")));
      h.debuggerSendCommand.mockImplementationOnce(async () => {
        commitAllowed(h);
        return {};
      });
      const response = await h.command(cdp(method, params));
      expectType(response, type);
      if (type === "error") {
        expect(response).toMatchObject({ message: "tab 101 access was revoked" });
        expect(response.result).toBeUndefined();
      } else {
        expectResult(response, {});
      }
    },
  );
  it.each(["pause", "detach"])("rejects a native configuration receipt after %s", async (cause) => {
    const h = await createHarness("selected");
    expectType(await h.command(createTab("https://example.com/source")));
    h.debuggerSendCommand.mockImplementationOnce(async () => {
      if (cause === "pause") {
        await runtime(h, "toggleTabAccess", { tabId: 101, accessMode: "selected", grant: false });
      } else {
        h.debuggerDetachListener?.({ tabId: 101 }, "canceled_by_user");
      }
      return {};
    });
    const response = await h.command(cdp("Network.setCacheDisabled", { cacheDisabled: true }));
    expectType(response, "error");
    expect(response.result).toBeUndefined();
  });
  it.each([
    { operation: continueRequest, order: "completion-first" },
    { operation: continueRequest, order: "commit-first" },
    { operation: authContinuation, order: "commit-first" },
  ])(
    "preserves $operation.method receipt and both sessions: $order",
    async ({ operation, order }) => {
      await completeAcrossCommit(await setup(operation), order);
    },
  );
  it.each([
    { method: "Fetch.enable", order: "commit-first" },
    { method: "Fetch.disable", order: "completion-first" },
  ])(
    "preserves configuration $method completion ($order) and lease ownership",
    async ({ method, order }) => {
      const rig = await setupConfiguration(method);
      await completeAcrossCommit(rig, order, async () => {
        expect(await rig.observer.request("Fetch.enable", {}, rig.observerSession)).toMatchObject({
          error: { message: expect.stringContaining("another session") },
        });
        expect(nativeCalls(rig)).toHaveLength(1);
      });
      const successor = await rig.observer.request("Fetch.enable", {}, rig.observerSession);
      if (method === "Fetch.disable") {
        expect.soft(successor).toMatchObject({ result: {} });
      } else {
        expect.soft(successor).toMatchObject({
          error: { message: expect.stringContaining("another session") },
        });
        expect(nativeCalls(rig)).toHaveLength(1);
      }
    },
  );
  it.each([
    ["configuration", "access"],
    ["streamed body", "document"],
    ["continuation", "attachment"],
    ["continuation", "connection"],
  ] as const)("rejects %s completion after %s revocation", async (operation, revocation) => {
    const rig =
      operation === "configuration"
        ? await setupConfiguration("Fetch.enable")
        : await setup(operation === "streamed body" ? bodyRead : continueRequest);
    const held = await holdNativeCompletion(rig);
    switch (revocation) {
      case "access":
        await runtime(rig.harness, "toggleTabAccess", {
          tabId: 101,
          accessMode: "selected",
          grant: false,
        });
        break;
      case "document":
        commitAllowed(rig.harness);
        break;
      case "attachment":
        rig.harness.debuggerDetachListener?.({ tabId: 101 }, "target_closed");
        break;
      case "connection":
        rig.harness.socket.close();
        break;
    }
    held.complete();
    const response = await rig.owner.response(held.id);
    expect(response.error).toBeDefined();
    expect(response).not.toHaveProperty("result");
    if (revocation !== "document") {
      const successor = await rig.owner.request("Page.getFrameTree", {}, rig.session);
      expect(successor).toHaveProperty("error");
      expect(successor.error).toBeDefined();
    }
    expect(nativeCalls(rig)).toHaveLength(1);
  });
});
