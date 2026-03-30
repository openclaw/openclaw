import { describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { createProfileSelectionOps } from "./server-context.selection.js";

function makeRelayProfile(): ResolvedBrowserProfile {
  return {
    name: "relay",
    cdpPort: 18792,
    cdpUrl: "http://127.0.0.1:18792",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    color: "#00AA00",
    driver: "openclaw",
    attachOnly: true,
    relayAttachUx: {
      provider: "local-browser-bridge",
      mode: "relay",
      sharedTabScope: "current-shared-tab",
    },
  };
}

describe("browser server-context selection local-browser-bridge relay UX", () => {
  it("returns attach-required guidance when no shared tab is attached", async () => {
    const state = {
      profile: makeRelayProfile(),
      running: null,
      lastTargetId: null,
      reconcile: null,
    };
    const ops = createProfileSelectionOps({
      profile: state.profile,
      getProfileState: () => state,
      ensureBrowserAvailable: vi.fn(async () => {}),
      listTabs: vi.fn(async () => []),
      openTab: vi.fn(async () => {
        throw new Error("relay selection should not open a local tab");
      }),
    });

    await expect(ops.ensureTabAvailable()).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await expect(ops.ensureTabAvailable()).rejects.toThrow(
      /click the relay extension button on the tab you want to share/i,
    );
    await expect(ops.ensureTabAvailable()).rejects.toThrow(/remains read-only/i);
  });

  it("falls back to the current shared tab when a stale relay target is the only choice", async () => {
    const state = {
      profile: makeRelayProfile(),
      running: null,
      lastTargetId: null,
      reconcile: null,
    };
    const ops = createProfileSelectionOps({
      profile: state.profile,
      getProfileState: () => state,
      ensureBrowserAvailable: vi.fn(async () => {}),
      listTabs: vi.fn(async () => [
        {
          targetId: "TAB_A",
          title: "Shared Tab",
          url: "https://example.com",
          type: "page",
        },
      ]),
      openTab: vi.fn(async () => {
        throw new Error("unexpected openTab");
      }),
    });

    const chosen = await ops.ensureTabAvailable("STALE_TARGET");
    expect(chosen.targetId).toBe("TAB_A");
    expect(state.lastTargetId).toBe("TAB_A");
  });

  it("returns shared-tab scope guidance when a relay target is stale and out of scope", async () => {
    const state = {
      profile: makeRelayProfile(),
      running: null,
      lastTargetId: null,
      reconcile: null,
    };
    const ops = createProfileSelectionOps({
      profile: state.profile,
      getProfileState: () => state,
      ensureBrowserAvailable: vi.fn(async () => {}),
      listTabs: vi.fn(async () => [
        {
          targetId: "TAB_A",
          title: "Tab A",
          url: "https://a.example",
          type: "page",
        },
        {
          targetId: "TAB_B",
          title: "Tab B",
          url: "https://b.example",
          type: "page",
        },
      ]),
      openTab: vi.fn(async () => {
        throw new Error("unexpected openTab");
      }),
    });

    await expect(ops.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/currently shared tab/i);
    await expect(ops.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/remains read-only/i);
  });

  it("keeps the default local-managed blank-tab fallback when relay UX is not enabled", async () => {
    const state = {
      profile: {
        ...makeRelayProfile(),
        relayAttachUx: undefined,
      },
      running: null,
      lastTargetId: null,
      reconcile: null,
    };
    const openTab = vi.fn(async () => ({
      targetId: "OPENED",
      title: "Opened",
      url: "about:blank",
      wsUrl: "ws://127.0.0.1/devtools/page/OPENED",
      type: "page" as const,
    }));
    const listTabs = vi
      .fn<
        () => Promise<
          Array<{ targetId: string; title: string; url: string; wsUrl?: string; type?: string }>
        >
      >()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          targetId: "OPENED",
          title: "Opened",
          url: "about:blank",
          wsUrl: "ws://127.0.0.1/devtools/page/OPENED",
          type: "page",
        },
      ]);
    const ops = createProfileSelectionOps({
      profile: state.profile,
      getProfileState: () => state,
      ensureBrowserAvailable: vi.fn(async () => {}),
      listTabs,
      openTab,
    });

    const chosen = await ops.ensureTabAvailable();
    expect(openTab).toHaveBeenCalledWith("about:blank");
    expect(chosen.targetId).toBe("OPENED");
  });
});
