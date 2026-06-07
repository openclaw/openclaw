// Browser tests cover server context.stop running browser plugin behavior.

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR } from "../utils.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

const pwAiMocks = vi.hoisted(() => ({
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
}));
const chromeMcpMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => []),
}));

vi.mock("./pw-ai.js", () => pwAiMocks);
vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test"),
  stopOpenClawChrome: vi.fn(async () => {}),
}));
vi.mock("./chrome-mcp.js", () => chromeMcpMocks);

afterEach(() => {
  vi.clearAllMocks();
});

function createStopHarness(profile: ReturnType<typeof makeBrowserProfile>) {
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: {
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
  });
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { profileCtx: ctx.forProfile(profile.name) };
}

describe("createProfileAvailability.stopRunningBrowser", () => {
  it("disconnects attachOnly loopback profiles without an owned process", async () => {
    const profile = makeBrowserProfile({ attachOnly: true });
    const { profileCtx } = createStopHarness(profile);

    await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: true });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
  });

  it("disconnects remote CDP profiles without an owned process", async () => {
    const profile = makeBrowserProfile({
      cdpUrl: "http://10.0.0.5:9222",
      cdpHost: "10.0.0.5",
      cdpIsLoopback: false,
      cdpPort: 9222,
    });
    const { profileCtx } = createStopHarness(profile);

    await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: true });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://10.0.0.5:9222",
    });
  });

  it("keeps never-started local managed profiles as not stopped", async () => {
    const profile = makeBrowserProfile();
    const { profileCtx } = createStopHarness(profile);

    await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: false });
    expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
  });

  it("passes Chrome MCP profile details to stop cleanup", async () => {
    const userDataDir = path.join(CONFIG_DIR, "browser", "chrome-live", "user-data");
    const profile = makeBrowserProfile({
      name: "chrome-live",
      driver: "existing-session",
      attachOnly: true,
      userDataDir,
      executablePath: "/usr/bin/google-chrome-stable",
    });
    chromeMcpMocks.closeChromeMcpSession.mockResolvedValueOnce(true);
    const { profileCtx } = createStopHarness(profile);

    await expect(profileCtx.stopRunningBrowser()).resolves.toEqual({ stopped: true });
    expect(chromeMcpMocks.closeChromeMcpSession).toHaveBeenCalledWith(
      "chrome-live",
      expect.objectContaining({
        name: "chrome-live",
        driver: "existing-session",
        userDataDir,
        cleanupBrowserProcesses: true,
      }),
    );
  });
});
