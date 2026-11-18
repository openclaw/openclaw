import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { setupMaintenance } from "./browser-maintenance.test-support.js";
import { durableOwnership } from "./src/browser/session-tab-registry.sqlite.test-helpers.js";

const runtime = vi.hoisted(() => ({
  loaded: [] as string[],
  coldImports: [] as string[],
  onClientLoad: undefined as (() => Promise<void>) | undefined,
  onControlLoad: undefined as (() => Promise<void>) | undefined,
  closeVolatile: vi.fn(async () => {}),
  closeDurable: vi.fn(async (..._args: unknown[]) => ({ status: "closed" as const })),
  getControlState: vi.fn(() => null),
}));

vi.mock("openclaw/plugin-sdk/browser-config", async (importOriginal) => {
  runtime.coldImports.push("browser-config");
  return await importOriginal();
});
vi.mock("./src/browser/config.js", async (importOriginal) => {
  runtime.coldImports.push("browser-config-resolution");
  return await importOriginal();
});
vi.mock("./src/browser/client-tab-close.runtime.js", async () => {
  runtime.loaded.push("client");
  await runtime.onClientLoad?.();
  return { browserCloseTabByRawTargetId: runtime.closeVolatile };
});
vi.mock("./src/browser/cdp.helpers.js", () => {
  runtime.loaded.push("cdp");
  return {
    closeTrackedCdpTarget: async (
      params: Parameters<typeof import("./src/browser/cdp.helpers.js").closeTrackedCdpTarget>[0],
    ) => {
      const dispatch = () => runtime.closeDurable(params);
      return params.closeIfCurrent ? await params.closeIfCurrent(dispatch) : await dispatch();
    },
  };
});
vi.mock("./src/browser-control-state.js", async () => {
  runtime.loaded.push("control");
  await runtime.onControlLoad?.();
  return { getBrowserControlState: runtime.getControlState };
});

it("loads browser close runtimes only for owned tabs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { store } = await setupMaintenance(state, "http://127.0.0.1:9222");
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
    const { trackSessionBrowserTab, untrackSessionBrowserTab } =
      await import("./src/browser/session-tab-registry.js");
    const sessionKey = "agent:main:browser-cleanup";
    const close = () => closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
    const tabDefaults = { sessionKey, profile: "remote", now: 1_000 };
    const controlUrl = "http://127.0.0.1:9999";
    try {
      await expect(close()).resolves.toBe(0);
      expect.soft(runtime.loaded).toEqual([]);
      expect.soft(runtime.coldImports).toEqual([]);

      for (const durable of [false, true]) {
        const tab = {
          ...tabDefaults,
          targetId: durable ? "durable-tab" : "volatile-tab",
          ...(durable
            ? { ownership: durableOwnership("native-tab", "p", "b") }
            : { route: { kind: "browser-control" as const, baseUrl: controlUrl } }),
        };
        await trackSessionBrowserTab(tab);
        runtime[durable ? "onControlLoad" : "onClientLoad"] = async () => {
          if (!durable) {
            await untrackSessionBrowserTab(tab);
          }
          await trackSessionBrowserTab({ ...tab, now: durable ? 2_000 : 1_000 });
        };
        await expect(close()).resolves.toBe(0);
        expect(durable ? runtime.closeDurable : runtime.closeVolatile).not.toHaveBeenCalled();
        if (durable) {
          expect(await store.entries()).toHaveLength(1);
        }
        await expect(close()).resolves.toBe(1);
        if (!durable) {
          expect.soft(runtime.loaded).toEqual(["client"]);
          expect(runtime.closeVolatile).toHaveBeenCalledWith(controlUrl, "volatile-tab", {
            profile: "remote",
          });
        }
      }
      expect(runtime.loaded.toSorted()).toEqual(["cdp", "client", "control"]);
      expect(runtime.coldImports).toContain("browser-config-resolution");
      expect(runtime.closeDurable).toHaveBeenCalledWith(
        expect.objectContaining({
          profileName: "remote",
          nativeTargetId: "native-tab",
          expectedProfileFingerprint: "p",
          expectedBrowserInstanceFingerprint: "b",
          closeIfCurrent: expect.any(Function),
        }),
      );
      expect(await store.entries()).toEqual([]);
      await expect(close()).resolves.toBe(0);
      expect(runtime.closeVolatile).toHaveBeenCalledOnce();
      expect(runtime.closeDurable).toHaveBeenCalledOnce();
    } finally {
      resetPluginStateStoreForTests();
    }
  });
});
