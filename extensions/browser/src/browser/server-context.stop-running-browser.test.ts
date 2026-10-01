import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const pwAiMocks = vi.hoisted(() => {
  const closePlaywrightBrowserConnection = vi.fn(async (_opts?: { cdpUrl?: string }) => {});
  return {
    closePlaywrightBrowserConnection,
    retirePlaywrightBrowserConnectionExact: vi.fn((opts: { cdpUrl: string }) => ({
      retired: true,
      close: async () => await closePlaywrightBrowserConnection(opts),
    })),
  };
});

const chromeMocks = vi.hoisted(() => ({
  stopOwnedOpenClawChrome: vi.fn<typeof import("./chrome.js").stopOwnedOpenClawChrome>(
    async () => ({ status: "not-running" }),
  ),
}));

vi.mock("./pw-ai.js", () => ({ pwAi: pwAiMocks }));
vi.mock("./chrome.js", () => ({
  isChromeCdpOwnedByPid: vi.fn(async () => true),
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test"),
  stopOwnedOpenClawChrome: chromeMocks.stopOwnedOpenClawChrome,
  stopOpenClawChrome: vi.fn(async () => {}),
}));
vi.mock("./chrome-mcp.js", () => ({
  closeChromeMcpSession: vi.fn(async () => false),
  countChromeMcpTabs: vi.fn(async () => 0),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => []),
}));

afterEach(() => {
  vi.clearAllMocks();
  chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({ status: "not-running" });
});

function createStopHarness(profile: ReturnType<typeof makeBrowserProfile>) {
  const state = makeBrowserServerState({ profile });
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profileCtx: ctx.forProfile(profile.name) };
}

describe("createProfileAvailability.stopRunningBrowser", () => {
  it.each([
    { name: "attach-only", overrides: { attachOnly: true } },
    {
      name: "remote",
      overrides: {
        cdpUrl: "http://10.0.0.5:9222",
        cdpHost: "10.0.0.5",
        cdpIsLoopback: false,
        cdpPort: 9222,
      },
    },
  ])(
    "stops an unused $name profile without loading Playwright or terminating Chrome",
    async ({ overrides }) => {
      const { profileCtx } = createStopHarness(makeBrowserProfile(overrides));
      await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: true });
      expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
      expect(chromeMocks.stopOwnedOpenClawChrome).not.toHaveBeenCalled();
    },
  );

  it.each(["not-running", "stopped"] as const)(
    "reports the managed Chrome owner result: %s",
    async (status) => {
      chromeMocks.stopOwnedOpenClawChrome.mockResolvedValue({ status });
      const { profileCtx } = createStopHarness(makeBrowserProfile());
      await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({
        stopped: status === "stopped",
      });
      expect(chromeMocks.stopOwnedOpenClawChrome).toHaveBeenCalledOnce();
      expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
    },
  );

  it.each(["existing-session", "extension"] as const)(
    "does not terminate a personal %s browser",
    async (driver) => {
      const { profileCtx } = createStopHarness(makeBrowserProfile({ driver }));
      await profileCtx.stopRunningBrowser();
      expect(chromeMocks.stopOwnedOpenClawChrome).not.toHaveBeenCalled();
    },
  );
});
