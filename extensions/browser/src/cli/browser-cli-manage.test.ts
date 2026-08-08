// Browser tests cover browser cli manage plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserManageProgram,
  findBrowserManageCall,
  getBrowserManageCallBrowserRequestMock,
} from "./browser-cli-manage.test-helpers.js";
import { getBrowserCliRuntime, getBrowserCliRuntimeCapture } from "./browser-cli.test-support.js";

function lastRuntimeLog(): string {
  const calls = getBrowserCliRuntime().log.mock.calls;
  const value = calls[calls.length - 1]?.[0];
  if (typeof value !== "string") {
    throw new Error("expected browser CLI runtime log");
  }
  return value;
}

function parseSingleRuntimeJson(): unknown {
  const logs = getBrowserCliRuntimeCapture().runtimeLogs;
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0] ?? "");
}

describe("browser manage output", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    getBrowserManageCallBrowserRequestMock().mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    getBrowserCliRuntime().exit.mockClear();
    getBrowserCliRuntime().writeJson.mockClear();
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("shows chrome-mcp transport for existing-session status without fake CDP fields", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "chrome-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            headlessSource: "default",
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("headless: false (default)");
    expect(output).not.toContain("cdpPort:");
    expect(output).not.toContain("cdpUrl:");
  });

  it("shows configured userDataDir for existing-session status", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "brave-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl: null,
            chosenBrowser: null,
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
            color: "#FB542B",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "brave-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain(
      "userDataDir: /Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
    );
  });

  it("shows configured cdpUrl for existing-session status", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "chrome-live",
            driver: "existing-session",
            transport: "chrome-mcp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: null,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            chosenBrowser: null,
            userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
            color: "#00AA00",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome-live", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("userDataDir:");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("shows chrome-mcp transport in browser profiles output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "chrome-live",
                driver: "existing-session",
                transport: "chrome-mcp",
                running: true,
                tabCount: 2,
                isDefault: false,
                isRemote: false,
                cdpPort: null,
                cdpUrl: null,
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("chrome-live: running (2 tabs) [existing-session]");
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("redacts remote cdpUrl details in browser profiles output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles"
        ? {
            profiles: [
              {
                name: "remote",
                driver: "openclaw",
                transport: "cdp",
                running: true,
                tabCount: 1,
                isDefault: false,
                isRemote: true,
                cdpPort: null,
                cdpUrl:
                  "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
                color: "#00AA00",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "profiles"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("shows chrome-mcp transport after creating an existing-session profile", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl: null,
            userDataDir: null,
            color: "#00AA00",
            isRemote: false,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      ["browser", "create-profile", "--name", "chrome-live", "--driver", "existing-session"],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).not.toContain("port: 0");
  });

  it("shows cdpUrl after creating an existing-session endpoint profile", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "chrome-live",
            transport: "chrome-mcp",
            cdpPort: null,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            userDataDir: null,
            color: "#00AA00",
            isRemote: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      [
        "browser",
        "create-profile",
        "--name",
        "chrome-live",
        "--driver",
        "existing-session",
        "--cdp-url",
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      ],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain('Created profile "chrome-live"');
    expect(output).toContain("transport: chrome-mcp");
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("redacts remote cdpUrl details after creating a remote profile", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/profiles/create"
        ? {
            ok: true,
            profile: "remote",
            transport: "cdp",
            cdpPort: null,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            userDataDir: null,
            color: "#00AA00",
            isRemote: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(
      [
        "browser",
        "create-profile",
        "--name",
        "remote",
        "--cdp-url",
        "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
      ],
      { from: "user" },
    );

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("redacts sensitive remote cdpUrl details in status output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "remote",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: null,
            cdpPort: 9222,
            cdpUrl:
              "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
            chosenBrowser: null,
            userDataDir: null,
            color: "#00AA00",
            headless: false,
            noSandbox: false,
            executablePath: null,
            attachOnly: true,
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "remote", "status"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("cdpUrl: https://example.com/chrome?token=supers…7890");
    expect(output).not.toContain("alice");
    expect(output).not.toContain("supersecretpasswordvalue1234");
    expect(output).not.toContain("supersecrettokenvalue1234567890");
  });

  it("prints managed graphics facts in status output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/"
        ? {
            enabled: true,
            profile: "openclaw",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
            cdpHttp: true,
            pid: 4321,
            cdpPort: 18800,
            cdpUrl: "http://127.0.0.1:18800",
            chosenBrowser: "chromium",
            userDataDir: null,
            color: "#00AA00",
            headless: true,
            noSandbox: false,
            executablePath: null,
            attachOnly: false,
            graphics: {
              status: "available",
              observedAt: 123,
              acceleration: "hardware",
              renderer: "ANGLE (Intel)",
              vendor: "Intel",
              version: "OpenGL ES 3.0",
              backend: "(gl=angle,angle=metal)",
              devices: [],
              featureStatus: {},
              disabledFeatures: [],
              driverBugWorkarounds: [],
              videoDecoding: [],
              videoEncoding: [],
            },
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(lastRuntimeLog()).toContain(
      "graphics: hardware; renderer ANGLE (Intel); backend (gl=angle,angle=metal)",
    );
  });

  it("prints suggested tab references while keeping raw target ids visible", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) =>
      req.path === "/tabs"
        ? {
            running: true,
            tabs: [
              {
                targetId: "RAW_TARGET_1",
                suggestedTargetId: "docs",
                tabId: "t1",
                label: "docs",
                title: "Docs",
                url: "https://docs.example.com",
              },
            ],
          }
        : {},
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "tabs"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("use: docs");
    expect(output).toContain("tab: t1");
    expect(output).toContain("label:docs");
    expect(output).toContain("id: RAW_TARGET_1");
  });

  it("rejects non-integer tab indexes without calling browser actions", async () => {
    const program = createBrowserManageProgram();

    await expect(
      program.parseAsync(["browser", "tab", "select", "1.9"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "index must be a positive integer",
    );

    getBrowserCliRuntimeCapture().resetRuntimeCapture();
    await expect(
      program.parseAsync(["browser", "tab", "close", "abc"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "index must be a positive integer",
    );
    expect(getBrowserManageCallBrowserRequestMock()).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: "/tabs/action" }),
      expect.anything(),
    );
  });

  it("accepts signed decimal tab indexes", async () => {
    const program = createBrowserManageProgram();

    await program.parseAsync(["browser", "tab", "select", "+2"], { from: "user" });

    expect(getBrowserManageCallBrowserRequestMock()).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: "/tabs/action",
        body: { action: "select", index: 1 },
      }),
      expect.anything(),
    );
  });

  it("rejects unsupported profile drivers before creating a profile", async () => {
    const program = createBrowserManageProgram();

    await expect(
      program.parseAsync(["browser", "create-profile", "--name", "test", "--driver", "chromium"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.at(-1)).toContain(
      "--driver must be openclaw or existing-session",
    );
    expect(getBrowserManageCallBrowserRequestMock()).not.toHaveBeenCalled();
  });

  it("prints a readable browser doctor report", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/") {
        return {
          enabled: true,
          profile: "openclaw",
          driver: "openclaw",
          transport: "cdp",
          running: true,
          cdpReady: true,
          cdpHttp: true,
          pid: 4321,
          cdpPort: 18792,
          cdpUrl: "http://127.0.0.1:18792",
          chosenBrowser: "chrome",
          userDataDir: null,
          color: "#00AA00",
          headless: false,
          noSandbox: false,
          executablePath: null,
          attachOnly: false,
          graphics: {
            status: "available",
            observedAt: 123,
            acceleration: "software",
            renderer: "ANGLE (Google, SwiftShader Device)",
            vendor: "Google Inc.",
            version: "OpenGL ES 3.0",
            backend: "(gl=angle,angle=swiftshader)",
            devices: [],
            featureStatus: {},
            disabledFeatures: [],
            driverBugWorkarounds: [],
            videoDecoding: [],
            videoEncoding: [],
          },
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "openclaw", running: true }] };
      }
      if (req.path === "/tabs") {
        return {
          running: true,
          tabs: [
            {
              targetId: "abc",
              tabId: "t1",
              suggestedTargetId: "t1",
              title: "Example",
              url: "https://example.com",
            },
          ],
        };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain("OK gateway: browser control endpoint reachable");
    expect(output).toContain("OK graphics: software");
    expect(output).toContain("OK tabs: 1 visible, use tab reference t1");
    expect(getBrowserCliRuntime().writeJson).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps deep doctor open long enough to surface the relay deadline context", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(
      async (_opts: unknown, req, runtimeOpts) => {
        if (req.path === "/profiles") {
          return { profiles: [{ name: "chrome", running: true }] };
        }
        if (req.path === "/tabs") {
          return {
            running: true,
            tabs: [{ targetId: "extension-target-1", title: "Example", url: "https://x.test" }],
          };
        }
        if (req.path === "/doctor") {
          if ((runtimeOpts?.timeoutMs ?? 0) <= 15_000) {
            throw new Error("browser request timed out before the relay deadline");
          }
          return {
            ok: false,
            profile: "chrome",
            transport: "extension",
            status: {
              enabled: true,
              profile: "chrome",
              driver: "extension",
              transport: "extension",
              running: true,
              cdpReady: true,
            },
            checks: [
              {
                id: "live-snapshot",
                label: "Live snapshot",
                status: "fail",
                summary:
                  "Error: extension relay command timed out: cdp (tabId=7, method=Accessibility.getFullAXTree)",
              },
            ],
          };
        }
        return {};
      },
    );

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor", "--deep"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain(
      "FAIL live-snapshot: Error: extension relay command timed out: cdp (tabId=7, method=Accessibility.getFullAXTree)",
    );
    expect(findBrowserManageCall("/doctor")?.[2]?.timeoutMs).toBeGreaterThan(15_000);
    expect(findBrowserManageCall("/doctor")?.[1]?.query).toMatchObject({
      profile: "chrome",
      deep: true,
    });
    expect(findBrowserManageCall("/snapshot")).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it("shares one 24-second default budget across deep-doctor requests", async () => {
    vi.useFakeTimers();
    try {
      getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
        if (req.path === "/doctor") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5_000);
          });
          return {
            ok: true,
            status: {
              enabled: true,
              profile: "chrome",
              driver: "extension",
              transport: "extension",
              running: true,
              cdpReady: true,
            },
            checks: [
              {
                id: "live-snapshot",
                label: "Live snapshot",
                status: "pass",
                summary: "snapshot succeeded",
              },
            ],
          };
        }
        if (req.path === "/profiles") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 4_000);
          });
          return { profiles: [{ name: "chrome", running: true }] };
        }
        if (req.path === "/tabs") {
          return { running: true, tabs: [] };
        }
        return {};
      });

      const program = createBrowserManageProgram();
      const pending = program.parseAsync(
        ["browser", "--browser-profile", "chrome", "doctor", "--deep"],
        { from: "user" },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await pending;

      expect(findBrowserManageCall("/doctor")?.[2]?.timeoutMs).toBe(24_000);
      expect(findBrowserManageCall("/profiles")?.[2]?.timeoutMs).toBe(19_000);
      expect(findBrowserManageCall("/tabs")?.[2]?.timeoutMs).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report success when the canonical deep-doctor report is unsuccessful", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: false,
          profile: "chrome",
          transport: "extension",
          status: {
            enabled: true,
            profile: "chrome",
            driver: "extension",
            transport: "extension",
            running: true,
            cdpReady: true,
          },
          checks: [
            {
              id: "plugin-enabled",
              label: "Browser plugin",
              status: "pass",
              summary: "enabled",
            },
            {
              id: "profile",
              label: "Profile",
              status: "pass",
              summary: "chrome via extension",
            },
            {
              id: "extension-relay",
              label: "Chrome extension relay",
              status: "pass",
              summary: "OpenClaw Chrome extension is connected",
            },
            {
              id: "live-snapshot",
              label: "Live snapshot",
              status: "pass",
              summary: "snapshot succeeded",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "chrome", running: true }] };
      }
      if (req.path === "/tabs") {
        return {
          running: true,
          tabs: [{ targetId: "extension-target-1", title: "Example", url: "https://x.test" }],
        };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor", "--deep"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain(
      "FAIL canonical-doctor: browser server reported an unsuccessful diagnostic",
    );
    expect(process.exitCode).toBe(1);
  });

  it("preserves the canonical plugin recovery hint in deep doctor output", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: false,
          profile: "chrome",
          transport: "extension",
          status: {
            enabled: false,
            profile: "chrome",
            driver: "extension",
            transport: "extension",
            running: false,
            cdpReady: false,
          },
          checks: [
            {
              id: "plugin-enabled",
              label: "Browser plugin",
              status: "fail",
              summary: "disabled in config",
              fixHint: "Enable the browser plugin and restart the Gateway.",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "chrome", running: false }] };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor", "--deep"], {
      from: "user",
    });

    expect(lastRuntimeLog()).toContain(
      "FAIL plugin: disabled in config Fix: Enable the browser plugin and restart the Gateway.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("trusts a successful canonical deep doctor after a short CDP status miss", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: true,
          profile: "attached",
          transport: "cdp",
          status: {
            enabled: true,
            profile: "attached",
            driver: "openclaw",
            transport: "cdp",
            running: false,
            cdpReady: false,
          },
          checks: [
            {
              id: "live-snapshot",
              label: "Live snapshot",
              status: "pass",
              summary: "snapshot succeeded after the short status miss",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        throw new Error("supplementary profile listing timed out");
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "attached", "doctor", "--deep"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("OK live-snapshot: snapshot succeeded after the short status miss");
    expect(output).toContain("WARN profiles: Error: supplementary profile listing timed out");
    expect(output).not.toContain("FAIL browser: not running");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps tab enrichment failures advisory when canonical deep doctor succeeds", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: true,
          profile: "remote",
          transport: "cdp",
          status: {
            enabled: true,
            profile: "remote",
            driver: "openclaw",
            transport: "cdp",
            running: true,
            cdpReady: true,
          },
          checks: [
            {
              id: "live-snapshot",
              label: "Live snapshot",
              status: "pass",
              summary: "remote snapshot succeeded",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "remote", running: true }] };
      }
      if (req.path === "/tabs") {
        throw new Error("supplementary tab listing timed out");
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "remote", "doctor", "--deep"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain("WARN tabs: Error: supplementary tab listing timed out");
    expect(output).toContain("OK live-snapshot: remote snapshot succeeded");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a stopped deep-doctor profile without probing tabs or snapshots", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: false,
          status: {
            enabled: true,
            profile: "openclaw",
            driver: "openclaw",
            transport: "cdp",
            running: false,
            cdpReady: false,
          },
          checks: [
            {
              id: "live-snapshot",
              label: "Live snapshot",
              status: "fail",
              summary: "Live snapshot probe requires a running browser profile.",
              fixHint: "Start or connect the browser profile, then retry.",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "openclaw", running: false }] };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor", "--deep"], { from: "user" });

    expect(lastRuntimeLog()).not.toContain("FAIL browser: not running");
    expect(lastRuntimeLog()).toContain(
      "FAIL live-snapshot: Live snapshot probe requires a running browser profile.",
    );
    expect(findBrowserManageCall("/doctor")).toBeDefined();
    expect(findBrowserManageCall("/tabs")).toBeUndefined();
    expect(findBrowserManageCall("/snapshot")).toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it("prints canonical extension pairing guidance instead of managed-browser startup advice", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/doctor") {
        return {
          ok: false,
          profile: "chrome",
          transport: "extension",
          status: {
            enabled: true,
            profile: "chrome",
            driver: "extension",
            transport: "extension",
            running: false,
            cdpReady: false,
          },
          checks: [
            {
              id: "extension-relay",
              label: "Chrome extension relay",
              status: "fail",
              summary: "OpenClaw Chrome extension is not connected",
              fixHint:
                "Install the OpenClaw Chrome extension, pair it, and paste the pairing string into the extension popup.",
            },
            {
              id: "live-snapshot",
              label: "Live snapshot",
              status: "fail",
              summary: "OpenClaw Chrome extension is not connected",
            },
          ],
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "chrome", running: false }] };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--browser-profile", "chrome", "doctor", "--deep"], {
      from: "user",
    });

    const output = lastRuntimeLog();
    expect(output).toContain(
      "FAIL extension-relay: OpenClaw Chrome extension is not connected Fix: Install the OpenClaw Chrome extension, pair it, and paste the pairing string into the extension popup.",
    );
    expect(output).not.toContain("FAIL browser: not running; run `openclaw browser start`");
    expect(process.exitCode).toBe(1);
  });

  it("prints one complete JSON browser doctor failure before setting exit status", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/") {
        return {
          enabled: false,
          profile: "openclaw",
          transport: "cdp",
          running: false,
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [] };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--json", "doctor"], { from: "user" });

    expect(parseSingleRuntimeJson()).toEqual(
      expect.objectContaining({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "gateway", ok: true }),
          expect.objectContaining({ name: "plugin", ok: false }),
        ]),
      }),
    );
    expect(getBrowserCliRuntimeCapture().runtimeErrors).toEqual([]);
    expect(getBrowserCliRuntime().writeJson).toHaveBeenCalledTimes(1);
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("prints one JSON browser doctor report and succeeds when every check passes", async () => {
    getBrowserManageCallBrowserRequestMock().mockImplementation(async (_opts: unknown, req) => {
      if (req.path === "/") {
        return {
          enabled: true,
          profile: "openclaw",
          transport: "cdp",
          running: true,
        };
      }
      if (req.path === "/profiles") {
        return { profiles: [{ name: "openclaw", running: true }] };
      }
      if (req.path === "/tabs") {
        return { running: true, tabs: [] };
      }
      return {};
    });

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "--json", "doctor"], { from: "user" });

    expect(parseSingleRuntimeJson()).toMatchObject({ ok: true });
    expect(getBrowserCliRuntimeCapture().runtimeErrors).toEqual([]);
    expect(getBrowserCliRuntime().writeJson).toHaveBeenCalledTimes(1);
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a readable browser doctor failure when gateway auth SecretRefs are unavailable", async () => {
    const error = Object.assign(new Error("gateway.auth.password unavailable"), {
      code: "GATEWAY_SECRET_REF_UNAVAILABLE",
      name: "GatewaySecretRefUnavailableError",
    });
    getBrowserManageCallBrowserRequestMock().mockRejectedValueOnce(error);

    const program = createBrowserManageProgram();
    await program.parseAsync(["browser", "doctor"], { from: "user" });

    const output = lastRuntimeLog();
    expect(output).toContain(
      "FAIL gateway: Gateway auth SecretRef is unavailable in this command path",
    );
    expect(output).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(output).not.toContain("GatewaySecretRefUnavailableError");
    expect(getBrowserCliRuntime().writeJson).not.toHaveBeenCalled();
    expect(getBrowserCliRuntime().exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
