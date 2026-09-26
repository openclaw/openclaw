import "../test-support/browser-security.mock.js";
import "../browser/server-context.chrome-test-harness.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserTool } from "../browser-tool.js";
import * as cdpHelpers from "../browser/cdp.helpers.js";
import { BrowserTabNotFoundError } from "../browser/errors.js";
import { withBrowserRequestScope } from "../browser/request-scope.js";
import * as screencastTokens from "../browser/screencast/tokens.js";
import { MANAGED_BROWSER_PAGE_TAB_LIMIT } from "../browser/server-context.constants.js";
import { mockLaunchedChrome } from "../browser/server-context.test-harness.js";
import { prepareBrowserSessionScope } from "../browser/session-scope.js";
import { prepareScopedSessionTabRegistry } from "../browser/session-tab-scoped.js";
import {
  browserSessionTabStorageKey,
  parseBrowserSessionTabRecord,
} from "../browser/session-tab-store.js";
import { runSessionTabNodeScenarios } from "./browser-request.session-tabs.node.test-support.js";
import {
  createSessionTabsTestFixture,
  requireEntry,
  type SessionTabsTestState,
  type SessionTabsTestMockFunctions,
} from "./browser-request.session-tabs.test-support.js";

const fixture = vi.hoisted(() => ({
  generations: new Map<string, string>(),
  revisions: new Map<string, string>(),
  beforeCapture: vi.fn(async () => {}),
  beforeList: vi.fn(async () => {}),
  nodeGatewayCall: vi.fn<SessionTabsTestMockFunctions["nodeGatewayCall"]>(),
  borrows: [] as Array<{
    sessionKey: string;
    controller: AbortController;
    release: ReturnType<typeof vi.fn>;
  }>,
  mcpList: vi.fn<SessionTabsTestMockFunctions["mcpList"]>(),
  mcpOpen: vi.fn<SessionTabsTestMockFunctions["mcpOpen"]>(),
  mcpClose: vi.fn<SessionTabsTestMockFunctions["mcpClose"]>(),
  context: undefined as SessionTabsTestState["context"],
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: fixture.nodeGatewayCall,
}));
vi.mock("../browser/chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: async () => ({
    ensureChromeMcpAvailable: async () => {},
    countChromeMcpTabs: async () => (await fixture.mcpList()).length,
    listChromeMcpTabs: fixture.mcpList,
    openChromeMcpTab: fixture.mcpOpen,
    closeChromeMcpTab: fixture.mcpClose,
    focusChromeMcpTab: async () => {},
  }),
}));
vi.mock("../browser-control-state.js", () => ({
  createBrowserControlContext: () => fixture.context,
  hasBrowserControlWork: () => false,
}));
vi.mock("../control-service.js", () => ({
  createBrowserControlContext: () => fixture.context,
  getBrowserControlState: () => fixture.context?.state() ?? null,
  startBrowserControlServiceFromConfig: async () => fixture.context?.state() ?? null,
}));

it.each(["openclaw", "existing-session"] as const)(
  "scopes registered requests and tools to exact session lifetimes in shared %s profiles",
  async (driver) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const h = await createSessionTabsTestFixture(driver, fixture);
      const {
        state,
        generations,
        tabs,
        closed,
        request,
        withNativeClosePreparation,
        readStandalone,
        syncReads,
        syncWrites,
      } = h;
      try {
        const a = "agent:main:a";
        const b = "agent:main:b";
        const firstOpen = await request(a, "POST", "/tabs/open", {
          url: "about:blank",
          label: "mine",
        });
        expect(firstOpen[0], JSON.stringify(firstOpen)).toBe(true);
        expect(
          (await request(b, "POST", "/tabs/open", { url: "about:blank", label: "theirs" }))[0],
        ).toBe(true);
        expect((await request(a, "GET", "/tabs"))[1]).toMatchObject({
          tabs: [{ targetId: "native-1" }],
        });
        expect((await request(a, "GET", "/tabs"))[1].tabs).toHaveLength(1);
        expect(
          (await request(b, "GET", "/tabs"))[1].tabs.map(
            (tab: { targetId: string }) => tab.targetId,
          ),
        ).toEqual(["native-2"]);
        expect((await request(undefined, "GET", "/tabs"))[1].tabs).toHaveLength(2);
        for (const targetId of ["native-2", "theirs", "t2"]) {
          expect((await request(a, "DELETE", "/tabs/" + targetId))[0]).toBe(false);
          expect((await request(a, "POST", "/navigate", { targetId, url: "about:blank" }))[0]).toBe(
            false,
          );
          expect((await request(a, "POST", "/screenshot", { targetId }))[0]).toBe(false);
        }
        expect(closed).toEqual([]);
        const owner = await prepareBrowserSessionScope(a);
        const selected = await withBrowserRequestScope(owner, async () =>
          fixture.context!.forProfile().ensureTabAvailable(),
        );
        expect(selected.targetId).toBe("native-1");
        const second = await request(a, "POST", "/tabs/open", { url: "about:blank" });
        expect(second[0]).toBe(true);
        expect(
          (
            await withBrowserRequestScope(owner, async () =>
              fixture.context!.forProfile().ensureTabAvailable(),
            )
          ).targetId,
        ).toBe("native-3");
        await withBrowserRequestScope(owner, () => fixture.context!.forProfile().focusTab("mine"));
        expect(
          (
            await withBrowserRequestScope(owner, () =>
              fixture.context!.forProfile().ensureTabAvailable(),
            )
          ).targetId,
        ).toBe("native-1");
        if (driver === "openclaw") {
          const { pwAi } = await import("../browser/pw-ai.js");
          const nativeClose = vi
            .spyOn(pwAi, "executeActViaPlaywright")
            .mockImplementationOnce(async ({ action, targetId }) => {
              expect(action.kind).toBe("close");
              expect(targetId).toBe("native-3");
              closed.push("native-3");
              tabs.splice(
                tabs.findIndex((tab) => tab.id === "native-3"),
                1,
              );
              return { targetId: "native-3" };
            });
          const closeResult = await request(a, "POST", "/act", {
            kind: "close",
            targetId: "native-3",
          });
          expect(closeResult[0], JSON.stringify(closeResult)).toBe(true);
          expect(
            JSON.stringify(await getBrowserStateRuntime().sessionTabDiscovery.entries()),
          ).not.toContain("native-3");
          nativeClose.mockRestore();
        } else {
          expect((await request(a, "DELETE", "/tabs/native-3"))[0]).toBe(true);
        }
        expect(closed).toEqual(["native-3"]);
        const tool = createBrowserTool({ agentSessionKey: a });
        const toolTabs = await tool.execute?.("tool-list", { action: "tabs", target: "host" });
        expect(toolTabs?.details).toMatchObject({ tabs: [{ targetId: "native-1" }] });
        await expect(
          tool.execute?.("foreign-tool-target", {
            action: "act",
            target: "host",
            request: { kind: "wait", timeMs: 1, targetId: "native-2" },
          }),
        ).rejects.toThrow("not associated with this session");
        // A native opener, not identical title/URL, inherits the owner's association.
        tabs.push({
          ...tabs[0]!,
          id: "popup-a",
          openerId: "native-1",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/popup-a",
        });
        expect(
          (await request(a, "GET", "/tabs"))[1].tabs.map(
            (tab: { targetId: string }) => tab.targetId,
          ),
        ).toEqual(driver === "openclaw" ? ["native-1", "popup-a"] : ["native-1"]);
        expect((await request(b, "GET", "/tabs"))[1].tabs).toHaveLength(1);
        // Admission must not silently bind an old invocation to a successor returned after an await.
        for (const revokeGuard of [false, true]) {
          const key = "agent:main:invocation-" + revokeGuard;
          generations.set(key, "original-invocation");
          const entered = createDeferred<void>();
          const proceed = createDeferred<void>();
          let current = true;
          fixture.beforeCapture.mockImplementationOnce(async () => {
            entered.resolve();
            await proceed.promise;
          });
          const oldTool = createBrowserTool({
            agentSessionKey: key,
            agentSessionId: "original-invocation",
            assertInvocationCurrent: () => {
              if (!current) {
                throw new Error("Invocation retired");
              }
            },
          });
          const pending = oldTool.execute!("old-invocation", { action: "tabs", target: "host" });
          const denied = expect(pending).rejects.toThrow(
            revokeGuard ? "Invocation retired" : "replaced session",
          );
          await requireEntry(entered.promise, pending);
          generations.set(key, "successor-invocation");
          current = !revokeGuard;
          proceed.resolve();
          await denied;
        }
        if (driver === "openclaw") {
          const store = getBrowserStateRuntime().sessionTabDiscovery;
          const entry = (await store.entries()).find(
            ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === "native-1",
          );
          if (!entry) {
            throw new Error("Original ordinary tab missing");
          }
          const original = parseBrowserSessionTabRecord(entry.value)!;
          const claimDashboard = async (targetId: string, sameKey: boolean) => {
            const sessionKey = sameKey ? a : "agent:main:dashboard-takeover";
            const claim = {
              ...original,
              sessionKey,
              nativeTargetId: targetId,
              dashboard: {
                name: "takeover",
                sessionKey,
                instanceId: "takeover-instance",
                url: "about:blank",
                state: "active" as const,
              },
            };
            const key = browserSessionTabStorageKey(claim);
            await store.register(key, claim);
            return { key, claim };
          };
          const localLeafTarget = "native-" + (h.nextId + 1);
          await withNativeClosePreparation(localLeafTarget, async (ownership, entered, proceed) => {
            vi.mocked(cdpHelpers.resolveCdpTabOwnership).mockResolvedValueOnce(ownership);
            const bind = store.withCurrent!.bind(store);
            const writeFailure = vi
              .spyOn(store, "withCurrent")
              .mockImplementationOnce((authority) => {
                const bound = bind(authority);
                return {
                  ...bound,
                  compareAndApply: async (...args) => {
                    await bound.compareAndApply(...args);
                    throw new Error("injected post-commit failure");
                  },
                };
              });
            const opening = request(a, "POST", "/tabs/open", { url: "about:blank" });
            await requireEntry(entered, opening);
            const saved = (await store.entries()).find(
              ({ value }) =>
                parseBrowserSessionTabRecord(value)?.nativeTargetId === localLeafTarget,
            );
            const record = parseBrowserSessionTabRecord(saved?.value);
            if (!saved || !record) {
              throw new Error("Committed allocation missing");
            }
            const claimed = {
              ...record,
              sessionKey: "agent:main:leaf-dashboard",
              dashboard: {
                name: "leaf",
                sessionKey: "agent:main:leaf-dashboard",
                instanceId: "leaf-instance",
                url: "about:blank",
                state: "active" as const,
              },
            };
            const claimKey = browserSessionTabStorageKey(claimed);
            await store.register(claimKey, claimed);
            proceed();
            const rejected = await opening;
            expect(rejected[0]).toBe(false);
            expect(rejected[2].message).toContain("injected post-commit failure");
            expect(tabs.some((tab) => tab.id === localLeafTarget)).toBe(true);
            expect(await store.lookup(claimKey)).toEqual(claimed);
            expect(await store.lookup(saved.key)).toEqual(record);
            writeFailure.mockRestore();
            await store.delete(claimKey);
            await store.delete(saved.key);
            tabs.splice(
              tabs.findIndex((tab) => tab.id === localLeafTarget),
              1,
            );
          });
          for (const sameKey of [true, false]) {
            const entered = createDeferred<void>();
            const proceed = createDeferred<void>();
            fixture.beforeList.mockImplementationOnce(async () => {
              entered.resolve();
              await proceed.promise;
            });
            const listing = request(a, "GET", "/tabs");
            await requireEntry(entered.promise, listing);
            const takeover = await claimDashboard("native-1", sameKey);
            proceed.resolve();
            const listed = await listing;
            expect(listed[0], JSON.stringify(listed)).toBe(true);
            expect(listed[1].tabs.map((tab: { targetId: string }) => tab.targetId)).not.toContain(
              "native-1",
            );
            expect((await request(a, "POST", "/screenshot", { targetId: "native-1" }))[0]).toBe(
              false,
            );
            expect(await store.lookup(takeover.key)).toEqual(takeover.claim);
            if (sameKey) {
              await store.register(entry.key, original);
            } else {
              await store.delete(takeover.key);
            }
          }
          tabs.push({ ...tabs[0]!, id: "dashboard-popup", openerId: "native-1" });
          const popupClaim = await claimDashboard("dashboard-popup", false);
          const withPopup = await request(a, "GET", "/tabs");
          expect(withPopup[0], JSON.stringify(withPopup)).toBe(true);
          expect(withPopup[1].tabs.map((tab: { targetId: string }) => tab.targetId)).not.toContain(
            "dashboard-popup",
          );
          expect(await store.lookup(popupClaim.key)).toEqual(popupClaim.claim);
          await store.delete(popupClaim.key);
          tabs.splice(
            tabs.findIndex((tab) => tab.id === "dashboard-popup"),
            1,
          );
          for (const sameKey of [true, false]) {
            const resolveOwnership = vi
              .mocked(cdpHelpers.resolveCdpTabOwnership)
              .getMockImplementation();
            if (!resolveOwnership) {
              throw new Error("Native ownership fixture missing");
            }
            const entered = createDeferred<void>();
            const proceed = createDeferred<void>();
            vi.mocked(cdpHelpers.resolveCdpTabOwnership).mockImplementationOnce(async (...args) => {
              const ownership = await resolveOwnership(...args);
              entered.resolve();
              await proceed.promise;
              return ownership;
            });
            const targetId = "native-" + (h.nextId + 1);
            const opening = request(a, "POST", "/tabs/open", { url: "about:blank" });
            await requireEntry(entered.promise, opening);
            const takeover = await claimDashboard(targetId, sameKey);
            proceed.resolve();
            const rejected = await opening;
            expect(rejected[0], JSON.stringify(rejected)).toBe(false);
            expect(tabs.some((tab) => tab.id === targetId)).toBe(true);
            expect(closed).not.toContain(targetId);
            expect(await store.lookup(takeover.key)).toEqual(takeover.claim);
            await store.delete(takeover.key);
            tabs.splice(
              tabs.findIndex((tab) => tab.id === targetId),
              1,
            );
          }
          await withBrowserRequestScope(await prepareBrowserSessionScope(a), async () => {
            const profile = fixture.context!.forProfile();
            await profile.listTabs();
            const entered = createDeferred<void>();
            const proceed = createDeferred<void>();
            fixture.beforeList.mockImplementationOnce(async () => {
              entered.resolve();
              await proceed.promise;
            });
            const closing = profile.closeTab("native-1");
            const denied = expect(closing).rejects.toThrow(BrowserTabNotFoundError);
            await requireEntry(entered.promise, closing);
            await store.register(entry.key, {
              ...original,
              dashboard: {
                name: "takeover",
                sessionKey: a,
                instanceId: "takeover-instance",
                url: "about:blank",
                state: "active",
              },
            });
            proceed.resolve();
            await denied;
            expect(tabs.some((tab) => tab.id === "native-1")).toBe(true);
            await store.register(entry.key, original);
          });
          const failureKey = "agent:main:commit-then-reset";
          generations.set(failureKey, "before-commit-reset");
          const bind = store.withCurrent!.bind(store);
          const commitThenReset = vi
            .spyOn(store, "withCurrent")
            .mockImplementationOnce((authority) => {
              const bound = bind(authority);
              return {
                ...bound,
                compareAndApply: async (...args) => {
                  const outcome = await bound.compareAndApply(...args);
                  generations.set(failureKey, "after-commit-reset");
                  return outcome;
                },
              };
            });
          const created = "native-" + (h.nextId + 1);
          const failed = await request(failureKey, "POST", "/tabs/open", { url: "about:blank" });
          expect(failed[0]).toBe(false);
          expect(failed[2].message).toContain("Session replaced");
          expect(tabs.some((tab) => tab.id === created)).toBe(false);
          expect(JSON.stringify(await store.entries())).not.toContain(created);
          commitThenReset.mockRestore();
          // A successor write at the same storage key cannot be retired by an old cleanup capability.
          const cleanupKey = "agent:main:cleanup-revision";
          generations.set(cleanupKey, "same-id");
          fixture.revisions.set(cleanupKey, "revision-one");
          const cleanupOwner = await prepareScopedSessionTabRegistry(
            await prepareBrowserSessionScope(cleanupKey),
          );
          const registration = cleanupOwner.prepareRegistration();
          const allocation: Parameters<typeof registration.track>[0] = {
            targetId: "cleanup-target",
            profile: "openclaw",
            ownership: {
              status: "durable",
              nativeTargetId: "cleanup-target",
              profileFingerprint: "cleanup-profile",
              browserInstanceFingerprint: "cleanup-browser",
            },
          };
          await registration.track(allocation);
          const saved = (await store.entries()).find(
            ({ value }) => parseBrowserSessionTabRecord(value)?.nativeTargetId === "cleanup-target",
          );
          if (!saved) {
            throw new Error("Prepared record missing");
          }
          const successor = {
            ...parseBrowserSessionTabRecord(saved.value)!,
            lifecycleRevision: "revision-two",
          };
          fixture.revisions.set(cleanupKey, "revision-two");
          await store.register(saved.key, successor);
          const nativeClose = vi.fn(async () => {});
          await registration.cleanup(allocation, nativeClose);
          expect(nativeClose).not.toHaveBeenCalled();
          expect(await store.lookup(saved.key)).toEqual(successor);
          await store.delete(saved.key);
        }
        const privateKey = "agent:main:dashboard:incognito-private-tab-test";
        generations.set(privateKey, "private-generation");
        const durableBeforePrivate = await getBrowserStateRuntime().sessionTabDiscovery.entries();
        const privateOpen = await request(privateKey, "POST", "/tabs/open", { url: "about:blank" });
        expect(privateOpen[0], JSON.stringify(privateOpen)).toBe(true);
        expect(
          (await request(privateKey, "GET", "/tabs"))[1].tabs.map(
            (tab: { targetId: string }) => tab.targetId,
          ),
        ).toEqual([privateOpen[1].targetId]);
        expect(await getBrowserStateRuntime().sessionTabDiscovery.entries()).toEqual(
          durableBeforePrivate,
        );
        if (driver === "openclaw") {
          const store = getBrowserStateRuntime().sessionTabDiscovery;
          const template = durableBeforePrivate
            .map(({ value }) => parseBrowserSessionTabRecord(value))
            .find((record) => record && !record.dashboard);
          if (!template) {
            throw new Error("Durable profile fixture missing");
          }
          const claimed = {
            ...template,
            sessionKey: "agent:main:private-tab-dashboard-owner",
            nativeTargetId: privateOpen[1].targetId,
            dashboard: {
              name: "private-takeover",
              sessionKey: "agent:main:private-tab-dashboard-owner",
              instanceId: "private-takeover",
              url: "about:blank",
              state: "active" as const,
            },
          };
          const claimKey = browserSessionTabStorageKey(claimed);
          await store.register(claimKey, claimed);
          expect((await request(privateKey, "GET", "/tabs"))[1].tabs).toEqual([]);
          expect(
            (
              await request(privateKey, "POST", "/screenshot", {
                targetId: privateOpen[1].targetId,
              })
            )[0],
          ).toBe(false);
          await store.delete(claimKey);
          expect(await store.entries()).toEqual(durableBeforePrivate);
        }
        expect((await request(b, "DELETE", "/tabs/" + privateOpen[1].targetId))[0]).toBe(false);
        expect((await request(privateKey, "DELETE", "/tabs/" + privateOpen[1].targetId))[0]).toBe(
          true,
        );
        // Standalone invocations must retain the stored revision even without a Gateway.
        const standaloneKey = "agent:main:standalone-revision";
        generations.set(standaloneKey, "standalone-id");
        fixture.revisions.set(standaloneKey, "standalone-one");
        const gateway = getBrowserStateRuntime().gateway;
        if (!gateway) {
          throw new Error("Fixture Gateway missing");
        }
        const unavailable = vi.spyOn(gateway, "isAvailable").mockResolvedValue(false);
        readStandalone.mockImplementation(async (params) => {
          params.assertCurrent();
          expect(params).toMatchObject({ sessionKey: standaloneKey, agentId: "main" });
          return {
            sessionId: "standalone-id",
            lifecycleRevision: fixture.revisions.get(standaloneKey),
            updatedAt: 1,
          };
        });
        let oldInvocationCurrent = true;
        const oldStandalone = createBrowserTool({
          agentSessionKey: standaloneKey,
          agentSessionId: "standalone-id",
          agentId: "main",
          assertInvocationCurrent: () => {
            if (!oldInvocationCurrent) {
              throw new Error("Old standalone invocation retired");
            }
          },
        });
        const oldStandaloneTarget = "native-" + (h.nextId + 1);
        await oldStandalone.execute!("standalone-one", {
          action: "open",
          target: "host",
          url: "about:blank",
        });
        oldInvocationCurrent = false;
        fixture.revisions.set(standaloneKey, "standalone-two");
        const newStandalone = createBrowserTool({
          agentSessionKey: standaloneKey,
          agentSessionId: "standalone-id",
          agentId: "main",
          assertInvocationCurrent: () => {},
        });
        expect(
          (await newStandalone.execute!("standalone-tabs", { action: "tabs", target: "host" }))
            .details,
        ).toMatchObject({ tabs: [] });
        const newStandaloneTarget = "native-" + (h.nextId + 1);
        await newStandalone.execute!("standalone-two", {
          action: "open",
          target: "host",
          url: "about:blank",
        });
        unavailable.mockRestore();
        readStandalone.mockReset();
        expect(
          (await request(standaloneKey, "GET", "/tabs"))[1].tabs.map(
            (tab: { targetId: string }) => tab.targetId,
          ),
        ).toEqual([newStandaloneTarget]);
        expect((await request(standaloneKey, "DELETE", "/tabs/" + oldStandaloneTarget))[0]).toBe(
          false,
        );
        if (driver === "openclaw") {
          const store = getBrowserStateRuntime().sessionTabDiscovery;
          const bind = store.withCurrent?.bind(store);
          if (!bind) {
            throw new Error("Missing action-bound store");
          }
          const trackingError = new Error("injected association write failure");
          const registration = vi
            .spyOn(store, "withCurrent")
            .mockImplementationOnce((authority) => ({
              ...bind(authority),
              compareAndApply: async () => {
                throw trackingError;
              },
            }));
          const failureOwner = await prepareBrowserSessionScope(b);
          const created = "native-" + (h.nextId + 1);
          await expect(
            withBrowserRequestScope(failureOwner, () =>
              fixture.context!.forProfile().openTab("about:blank"),
            ),
          ).rejects.toBe(trackingError);
          expect(closed).toContain(created);
          expect(tabs.some((tab) => tab.id === created)).toBe(false);
          registration.mockRestore();
          const profileRuntime = state.profiles.get("openclaw");
          if (!profileRuntime) {
            throw new Error("Profile runtime missing");
          }
          profileRuntime.running = mockLaunchedChrome(vi.fn(), 123);
          while (tabs.length < MANAGED_BROWSER_PAGE_TAB_LIMIT) {
            const id = "foreign-cap-" + tabs.length;
            tabs.push({
              id,
              type: "page",
              title: "Unassociated global tab",
              url: "about:blank",
              webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/" + id,
            });
          }
          const beforeCapacity = tabs.map((tab) => tab.id);
          const fullSession = "agent:main:at-capacity";
          generations.set(fullSession, "capacity-generation");
          const rejected = await request(fullSession, "POST", "/tabs/open", { url: "about:blank" });
          expect(rejected[0]).toBe(false);
          expect(rejected[2].message).toContain("capacity");
          expect(tabs.map((tab) => tab.id)).toEqual(beforeCapacity);
          // The shared browser can already be over capacity because another owner opened tabs.
          // B has an eligible tab, but not enough to make this new allocation fit.
          tabs.push({
            id: "foreign-over-cap",
            type: "page",
            title: "Other owner",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/foreign-over-cap",
          });
          const overCapacityOriginals = tabs.map((tab) => tab.id);
          const closedBeforeFailure = closed.length;
          const failedAllocation = "native-" + (h.nextId + 1);
          const overCapacity = await request(b, "POST", "/tabs/open", { url: "about:blank" });
          expect(overCapacity[0]).toBe(false);
          expect(overCapacity[2].message).toContain("capacity");
          expect(tabs.map((tab) => tab.id)).toEqual(overCapacityOriginals);
          expect(closed.slice(closedBeforeFailure)).toEqual([failedAllocation]);
          tabs.splice(
            tabs.findIndex((tab) => tab.id === "foreign-over-cap"),
            1,
          );
          const ownReplacement = await request(b, "POST", "/tabs/open", { url: "about:blank" });
          expect(ownReplacement[0], JSON.stringify(ownReplacement)).toBe(true);
          expect(tabs).toHaveLength(MANAGED_BROWSER_PAGE_TAB_LIMIT);
          expect(closed).toContain("native-2");
          expect(tabs.some((tab) => tab.id === "native-1")).toBe(true);
          const minted = vi
            .spyOn(screencastTokens, "mintBrowserScreencastToken")
            .mockReturnValue({ token: "test-stream-token", expiresAtMs: 12345 });
          const stream = await request(b, "POST", "/screencast", {
            targetId: ownReplacement[1].targetId,
          });
          expect(stream[0], JSON.stringify(stream)).toBe(true);
          const streamOwner = minted.mock.calls[0]?.[0];
          expect(streamOwner).toBeDefined();
          streamOwner?.assertCurrent?.();
          generations.set(b, "replacement-b");
          expect(() => streamOwner?.assertCurrent?.()).toThrow("Session replaced");
          minted.mockRestore();
        }
        fixture.revisions.set(a, "same-id-new-revision");
        expect((await request(a, "GET", "/tabs"))[1].tabs).toEqual([]);
        expect((await request(a, "DELETE", "/tabs/native-1"))[0]).toBe(false);
        generations.set(a, "replacement-a");
        expect((await request(a, "GET", "/tabs"))[1].tabs).toEqual([]);
        expect((await request(a, "DELETE", "/tabs/native-1"))[0]).toBe(false);
        if (driver === "openclaw") {
          h.setBrowserInstance("browser-restarted");
          expect((await request(b, "GET", "/tabs"))[1].tabs).toEqual([]);
        }
        expect(syncReads).not.toHaveBeenCalled();
        expect(syncWrites).not.toHaveBeenCalled();
        if (driver === "openclaw") {
          await runSessionTabNodeScenarios(h);
        }
      } finally {
        h.cleanup();
      }
    });
  },
);
