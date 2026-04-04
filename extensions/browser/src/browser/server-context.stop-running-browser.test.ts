import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfileAvailability } from "./server-context.availability.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

const pwAiMocks = vi.hoisted(() => ({
  closePlaywrightBrowserConnection: vi.fn(async () => {}),
}));

vi.mock("./pw-ai.js", () => pwAiMocks);
vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchOpenClawChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  stopOpenClawChrome: vi.fn(async () => {}),
}));
vi.mock("./chrome-mcp.js", () => ({
  closeChromeMcpSession: vi.fn(async () => false),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => []),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makeProfile(
  overrides: Partial<Parameters<typeof createProfileAvailability>[0]["profile"]> = {},
): Parameters<typeof createProfileAvailability>[0]["profile"] {
  return {
    name: "openclaw",
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 18800,
    color: "#f60",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
  };
}

function makeState(
  profile: Parameters<typeof createProfileAvailability>[0]["profile"],
): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: false,
      controlPort: 18791,
      cdpProtocol: "http",
      cdpHost: profile.cdpHost,
      cdpIsLoopback: profile.cdpIsLoopback,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18810,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: profile.color,
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      defaultProfile: profile.name,
      profiles: {
        [profile.name]: profile,
      },
    },
    profiles: new Map(),
  };
}

function createStopHarness(profile: Parameters<typeof createProfileAvailability>[0]["profile"]) {
  const state = makeState(profile);
  const runtimeState: ProfileRuntimeState = {
    profile,
    running: null,
    lastTargetId: null,
    reconcile: null,
  };
  state.profiles.set(profile.name, runtimeState);

  const ops = createProfileAvailability({
    opts: { getState: () => state },
    profile,
    state: () => state,
    getProfileState: () => runtimeState,
    setProfileRunning: (running) => {
      runtimeState.running = running;
    },
  });

  return { ops };
}

describe("createProfileAvailability.stopRunningBrowser", () => {
  it("disconnects attachOnly loopback profiles without an owned process", async () => {
    const profile = makeProfile({ attachOnly: true });
    const { ops } = createStopHarness(profile);

    await expect(ops.stopRunningBrowser()).resolves.toEqual({ stopped: true });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
    });
  });

  it("disconnects remote CDP profiles without an owned process", async () => {
    const profile = makeProfile({
      cdpUrl: "http://10.0.0.5:9222",
      cdpHost: "10.0.0.5",
      cdpIsLoopback: false,
      cdpPort: 9222,
    });
    const { ops } = createStopHarness(profile);

    await expect(ops.stopRunningBrowser()).resolves.toEqual({ stopped: true });
    expect(pwAiMocks.closePlaywrightBrowserConnection).toHaveBeenCalledWith({
      cdpUrl: "http://10.0.0.5:9222",
    });
  });

  it("keeps never-started local managed profiles as not stopped", async () => {
    const profile = makeProfile();
    const { ops } = createStopHarness(profile);

    await expect(ops.stopRunningBrowser()).resolves.toEqual({ stopped: false });
    expect(pwAiMocks.closePlaywrightBrowserConnection).not.toHaveBeenCalled();
  });
});
