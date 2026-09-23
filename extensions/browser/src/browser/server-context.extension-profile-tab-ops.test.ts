import { describe, expect, it, vi } from "vitest";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
  type RemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

function mockExtensionPage(targetIds = ["TARGET-41"]): void {
  vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
    listPagesViaPlaywright: vi.fn(async () =>
      targetIds.map((targetId) => ({
        targetId,
        title: "Extension test",
        url: "https://example.com/login",
        type: "page",
      })),
    ),
  } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
}

function createExtensionProfile() {
  const state = deps.makeState("openclaw");
  state.resolved.defaultProfile = "chrome";
  state.resolved.profiles.chrome = {
    cdpUrl: "http://127.0.0.1:18799",
    cdpPort: 18799,
    color: "#FF4500",
    driver: "extension",
  };
  return deps
    .createTestBrowserRouteContext({
      getState: () => state,
    })
    .forProfile("chrome");
}

describe("browser extension profile tab ops", () => {
  it("matches native ids by CDP target despite identical page metadata and different order", async () => {
    mockExtensionPage(["TARGET-41", "TARGET-42", "TARGET-43"]);
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        [42, 99, 41].map((tabId) => ({
          id: `TARGET-${tabId}`,
          tabId,
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        })),
      ),
    );

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toEqual([
      expect.objectContaining({
        targetId: "TARGET-41",
        tabId: "t1",
        webExtensionTabId: 41,
      }),
      expect.objectContaining({
        targetId: "TARGET-42",
        tabId: "t2",
        webExtensionTabId: 42,
      }),
      expect.objectContaining({ targetId: "TARGET-43", tabId: "t3" }),
    ]);
    expect(tabs[2]).not.toHaveProperty("webExtensionTabId");
  });

  it("does not expose a malformed native WebExtension tab id", async () => {
    mockExtensionPage();
    globalThis.fetch = vi.fn(async () =>
      Response.json([
        {
          id: "TARGET-41",
          tabId: "41",
          title: "Extension test",
          url: "https://example.com/login",
          type: "page",
        },
      ]),
    );

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).not.toHaveProperty("webExtensionTabId");
  });

  it("preserves caller cancellation during the native extension metadata request", async () => {
    mockExtensionPage();
    const controller = new AbortController();
    const reason = new Error("tab listing cancelled");
    let fetchSignal: AbortSignal | null | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      fetchSignal = init?.signal;
      controller.abort(reason);
      throw reason;
    });

    await expect(createExtensionProfile().listTabs({ signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("keeps tab listing available when native extension metadata cannot be read", async () => {
    mockExtensionPage();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("relay metadata unavailable");
    });

    const tabs = await createExtensionProfile().listTabs();

    expect(tabs).toEqual([expect.objectContaining({ targetId: "TARGET-41", tabId: "t1" })]);
    expect(tabs[0]).not.toHaveProperty("webExtensionTabId");
  });
});
