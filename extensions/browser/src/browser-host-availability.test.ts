import { ChildProcess } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExecutable } from "./browser/chrome.executables.js";
import type { RunningChrome } from "./browser/chrome.js";
import type { BrowserServerState } from "./browser/server-context.types.js";

const { getState, getSource, isReachable, resolveExecutable } = vi.hoisted(() => ({
  getState: vi.fn<() => BrowserServerState | null>(() => null),
  getSource: vi.fn<() => OpenClawConfig | null>(() => null),
  isReachable: vi.fn(async () => false),
  resolveExecutable: vi.fn<() => BrowserExecutable | null>(() => null),
}));
vi.mock("./browser-control-state.js", () => ({ getBrowserControlState: getState }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  getRuntimeConfigSourceSnapshot: getSource,
}));
vi.mock("./browser/chrome.js", () => ({ isChromeReachable: isReachable }));
vi.mock("./browser/chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: resolveExecutable,
}));

import { isBrowserHostAvailable } from "./browser-host-availability.js";
import { resolveBrowserNodeTarget } from "./browser-node-routing.js";
import { resolveBrowserConfig, resolveProfile } from "./browser/config.js";

describe("browser host availability", () => {
  beforeEach(() => {
    getState.mockReset().mockReturnValue(null);
    getSource.mockReset().mockReturnValue(null);
    isReachable.mockReset().mockResolvedValue(false);
    resolveExecutable
      .mockReset()
      .mockReturnValue({ kind: "chrome", path: "/usr/bin/google-chrome" });
  });

  it("keeps a stopped managed browser local when its executable exists", async () => {
    expect(await isBrowserHostAvailable({})).toBe(true);
    expect(isReachable).not.toHaveBeenCalled();
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable({})).toBe(false);
  });

  it.each([
    ["disabled browser", { browser: { enabled: false } }, undefined],
    ["missing profile", {}, "missing"],
  ] as const)("allows node fallback for a %s", async (_name, config, profile) => {
    expect(await isBrowserHostAvailable(config, profile)).toBe(false);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it.each([
    { driver: "existing-session" },
    { driver: "extension" },
    { cdpUrl: "https://browser.example.test" },
  ] as const)("preserves configured %j without a managed executable", async (profile) => {
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable({ browser: { profiles: { work: profile } } }, "work")).toBe(
      true,
    );
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("preserves a running managed browser when its executable is removed", async () => {
    const resolved = resolveBrowserConfig(undefined);
    const profile = expectDefined(
      resolveProfile(resolved, resolved.defaultProfile),
      "default profile",
    );
    const running: RunningChrome = {
      pid: 123,
      exe: { kind: "chrome", path: "/usr/bin/google-chrome" },
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
    expect(await isBrowserHostAvailable({ browser: { executablePath: "/missing/chrome" } })).toBe(
      true,
    );
  });

  it.each([false, true])(
    "keeps an explicit shell on its host instead of substituting a node profile (headless=%s)",
    async (headless) => {
      const executablePath = "/browsers/chrome-headless-shell";
      resolveExecutable.mockReturnValue({ kind: "custom", path: executablePath });
      const nodes = vi.fn(() => [{ nodeId: "other-host", caps: ["browser"] }]);
      const config = { browser: { executablePath, headless } };
      expect(await resolveBrowserNodeTarget({ config, nodes })).toBeNull();
      expect(nodes).not.toHaveBeenCalled();
      expect(isReachable).not.toHaveBeenCalled();
    },
  );
});
