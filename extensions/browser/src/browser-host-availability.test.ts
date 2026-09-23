import { ChildProcess } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserExecutable } from "./browser/chrome.executables.js";
import type { BrowserServerState } from "./browser/server-context.types.js";

const { getState, getSource, isReachable, resolveExecutable } = vi.hoisted(() => ({
  getState: vi.fn<() => BrowserServerState | null>(() => null),
  getSource: vi.fn<() => OpenClawConfig | null>(() => null),
  isReachable: vi.fn(async () => false),
  resolveExecutable: vi.fn<() => BrowserExecutable | null>(() => null),
}));
vi.mock("./browser-control-state.js", () => ({ getBrowserControlState: getState }));
vi.mock("./config/config.js", () => ({ getRuntimeConfigSourceSnapshot: getSource }));
vi.mock("./browser/chrome.js", () => ({ isChromeReachable: isReachable }));
vi.mock("./browser/chrome.executables.js", () => ({
  resolveBrowserExecutableForPlatform: resolveExecutable,
}));

import { isBrowserHostAvailable } from "./browser-host-availability.js";
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

  it("resolves the requested profile's executable ahead of global defaults", async () => {
    const config: OpenClawConfig = {
      browser: {
        executablePath: "/opt/default/chrome",
        profiles: { work: { cdpPort: 18801, executablePath: "/opt/work/chrome" } },
      },
    };
    expect(await isBrowserHostAvailable(config, "work")).toBe(true);
    expect(resolveExecutable).toHaveBeenLastCalledWith(
      expect.objectContaining({ executablePath: "/opt/work/chrome" }),
      process.platform,
    );
    expect(await isBrowserHostAvailable(config)).toBe(true);
    expect(resolveExecutable).toHaveBeenLastCalledWith(
      expect.objectContaining({ executablePath: "/opt/default/chrome" }),
      process.platform,
    );
  });

  it.each([
    { name: "disabled browser", config: { browser: { enabled: false } }, profile: undefined },
    { name: "missing profile", config: {}, profile: "missing" },
  ])("allows node fallback for a $name", async ({ config, profile }) => {
    expect(await isBrowserHostAvailable(config, profile)).toBe(false);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it.each([
    { name: "existing-session", profile: { driver: "existing-session" as const } },
    { name: "extension", profile: { driver: "extension" as const } },
    { name: "attach-only", profile: { cdpPort: 18801, attachOnly: true } },
    { name: "remote CDP", profile: { cdpUrl: "https://browser.example.test" } },
  ])(
    "preserves a configured $name connection without a managed executable",
    async ({ profile }) => {
      resolveExecutable.mockReturnValue(null);
      expect(
        await isBrowserHostAvailable({ browser: { profiles: { work: profile } } }, "work"),
      ).toBe(true);
      expect(resolveExecutable).not.toHaveBeenCalled();
    },
  );

  it("preserves a running managed browser when its executable is removed", async () => {
    const resolved = resolveBrowserConfig(undefined);
    const profile = expectDefined(
      resolveProfile(resolved, resolved.defaultProfile),
      "default profile",
    );
    getState.mockReturnValue({
      port: resolved.controlPort,
      resolved,
      profiles: new Map([
        [
          profile.name,
          {
            profile,
            running: {
              pid: 123,
              exe: { kind: "chrome", path: "/usr/bin/google-chrome" },
              userDataDir: "/browser/user-data",
              cdpPort: profile.cdpPort,
              startedAt: 1,
              proc: new ChildProcess(),
            },
          },
        ],
      ]),
    });
    resolveExecutable.mockReturnValue(null);
    expect(await isBrowserHostAvailable({})).toBe(true);
    expect(resolveExecutable).not.toHaveBeenCalled();
  });

  it("recognizes a surviving browser after its runtime and executable were removed", async () => {
    resolveExecutable.mockReturnValue(null);
    isReachable.mockResolvedValue(true);
    expect(await isBrowserHostAvailable({})).toBe(true);
    expect(isReachable).toHaveBeenCalledWith("http://127.0.0.1:18800");
  });

  it("uses the browser owner's source snapshot after config refresh", async () => {
    getSource.mockReturnValue({ browser: { executablePath: "/updated/chrome" } });
    expect(await isBrowserHostAvailable({ browser: { enabled: false } })).toBe(true);
    expect(resolveExecutable).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: "/updated/chrome" }),
      process.platform,
    );
  });

  it("leaves an invalid explicit executable on the host to report its configuration error", async () => {
    resolveExecutable.mockImplementation(() => {
      throw new Error("browser.executablePath not found");
    });
    expect(await isBrowserHostAvailable({ browser: { executablePath: "/missing/chrome" } })).toBe(
      true,
    );
  });
});
