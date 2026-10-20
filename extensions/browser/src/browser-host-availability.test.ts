import { ChildProcess } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExecutable } from "./browser/chrome.executables.js";
import type { RunningChrome } from "./browser/chrome.js";
import type { BrowserServerState } from "./browser/server-context.types.js";

const { getState, isReachable, resolveExecutable } = vi.hoisted(() => ({
  getState: vi.fn<() => BrowserServerState | null>(() => null),
  isReachable: vi.fn(async () => false),
  resolveExecutable: vi.fn<() => BrowserExecutable | null>(() => null),
}));
vi.mock("./browser-control-state.js", () => ({ getBrowserControlState: getState }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfigSourceSnapshot: () => null,
}));
vi.mock("./browser/chrome.js", () => ({ isChromeReachable: isReachable }));
vi.mock("./browser/chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: resolveExecutable,
}));

import { isBrowserHostAvailable } from "./browser-host-availability.js";
import { resolveBrowserNodeTarget } from "./browser-node-routing.js";
import { resolveBrowserConfig, resolveProfile } from "./browser/config.js";

const executable: BrowserExecutable = { kind: "chrome", path: "/usr/bin/google-chrome" };

describe("browser host availability", () => {
  beforeEach(() => {
    getState.mockReset().mockReturnValue(null);
    isReachable.mockReset().mockResolvedValue(false);
    resolveExecutable.mockReset().mockReturnValue(executable);
  });

  it("keeps a stopped managed browser local when its executable exists", async () => {
    expect(await isBrowserHostAvailable({})).toBe(true);
    expect(isReachable).not.toHaveBeenCalled();
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable({})).toBe(false);
  });

  it.each([
    [false, { browser: { enabled: false } }],
    [false, {}],
    [true, { browser: { profiles: { work: { driver: "existing-session" } } } }],
    [true, { browser: { profiles: { work: { driver: "extension" } } } }],
    [true, { browser: { profiles: { work: { cdpUrl: "https://browser.example.test" } } } }],
  ] as const)("availability=%s for %j", async (available, config) => {
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable(config, "work")).toBe(available);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("preserves a running managed browser when its executable is removed", async () => {
    const resolved = resolveBrowserConfig(undefined);
    const profile = expectDefined(resolveProfile(resolved, resolved.defaultProfile), "profile");
    const running: RunningChrome = {
      pid: 123,
      exe: executable,
      userDataDir: "/browser/user-data",
      cdpPort: profile.cdpPort,
      proc: new ChildProcess(),
    };
    getState.mockReturnValue({
      port: resolved.controlPort,
      resolved,
      profiles: new Map([[profile.name, { profile, running }]]),
    });
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable({})).toBe(true);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("leaves an invalid explicit executable on the host to report its configuration error", async () => {
    resolveExecutable.mockImplementation(() => {
      throw new Error("browser.executablePath not found");
    });
    const config = { browser: { executablePath: "/missing/chrome" } };
    expect(await isBrowserHostAvailable(config)).toBe(true);
  });

  it.each([false, true])("keeps headless=%s on its configured host", async (headless) => {
    const executablePath = "/browsers/chrome-headless-shell";
    resolveExecutable.mockReturnValue({ kind: "custom", path: executablePath });
    const nodes = vi.fn(() => [{ nodeId: "other-host", caps: ["browser"] }]);
    const config = { browser: { executablePath, headless } };
    expect(await resolveBrowserNodeTarget({ config, nodes })).toBeNull();
    expect(nodes).not.toHaveBeenCalled();
    expect(isReachable).not.toHaveBeenCalled();
  });
});
