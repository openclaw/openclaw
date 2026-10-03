// Browser tests cover doctor browser plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  maybeArchiveLegacyClawdBrowserProfileResidue,
  noteChromeMcpBrowserReadiness,
} from "./doctor-browser.js";

const managedBrowserConfig = {
  browser: {
    extensionRelay: { allowLegacyAuth: false },
    profiles: { openclaw: { cdpPort: 18800 } },
  },
} satisfies Parameters<typeof noteChromeMcpBrowserReadiness>[0];

const managedHost = {
  platform: "linux",
  env: { DISPLAY: ":99" },
  getUid: () => 1000,
  resolveManagedExecutable: () => ({ kind: "chrome", path: "/usr/bin/google-chrome" }),
} satisfies NonNullable<Parameters<typeof noteChromeMcpBrowserReadiness>[1]>;

function requireFirstNoteText(noteFn: ReturnType<typeof vi.fn>): string {
  const [call] = noteFn.mock.calls;
  if (!call) {
    throw new Error("expected browser doctor note");
  }
  const [message] = call;
  return String(message);
}

function requireNoteTextContaining(noteFn: ReturnType<typeof vi.fn>, expected: string): string {
  const call = noteFn.mock.calls.find(([message]) => String(message).includes(expected));
  if (!call) {
    throw new Error(`expected browser doctor note containing ${expected}`);
  }
  return String(call[0]);
}

describe("browser doctor readiness", () => {
  it("does nothing when Chrome MCP is not configured", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(managedBrowserConfig, {
      noteFn,
      ...managedHost,
    });
    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns while legacy Browser Relay Authentication remains enabled", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: true },
          profiles: {
            openclaw: { cdpPort: 18800 },
          },
        },
      },
      {
        noteFn,
        ...managedHost,
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining("browser.extensionRelay.allowLegacyAuth=true"),
      "Browser relay authentication",
    );
  });

  it("warns when managed browser profiles have no local executable", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(managedBrowserConfig, {
      noteFn,
      ...managedHost,
      resolveManagedExecutable: () => null,
    });

    expect(noteFn).toHaveBeenCalledWith(
      [
        "- OpenClaw-managed browser profile(s) are configured: openclaw.",
        "- No Chromium-based browser executable was found on this host for OpenClaw-managed launch.",
        "- Install Chrome, Chromium, Brave, Edge, or set browser.executablePath explicitly.",
      ].join("\n"),
      "Browser",
    );
  });

  it("warns when managed browser launch needs display and no-sandbox adjustments", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          headless: false,
          noSandbox: false,
          profiles: {
            openclaw: { cdpPort: 18800 },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        env: {},
        getUid: () => 0,
        resolveManagedExecutable: () => ({ kind: "chromium", path: "/usr/bin/chromium" }),
      },
    );

    expect(noteFn).toHaveBeenCalledWith(
      [
        "- OpenClaw-managed browser profile(s) are configured: openclaw.",
        "- No DISPLAY or WAYLAND_DISPLAY is set, and browser.headless is false. Managed browser launch needs a desktop session, Xvfb, or browser.headless: true.",
        "- The Gateway is running as root and browser.noSandbox is false. Chromium commonly requires browser.noSandbox: true in container/root runtimes.",
      ].join("\n"),
      "Browser",
    );
  });

  it("warns about legacy clawd managed browser profile residue", async () => {
    const noteFn = vi.fn();
    const configDir = "/tmp/openclaw-home";

    await noteChromeMcpBrowserReadiness(managedBrowserConfig, {
      noteFn,
      ...managedHost,
      configDir,
      pathExists: (targetPath) => targetPath.endsWith("/browser/clawd/user-data"),
    });

    expect(noteFn).toHaveBeenCalledTimes(1);
    const note = requireFirstNoteText(noteFn);
    expect(note).toContain("Legacy managed browser profile residue");
    expect(note).toContain("/tmp/openclaw-home/browser/clawd");
    expect(note).toContain("/tmp/openclaw-home/browser/openclaw/user-data");
    expect(note).toContain("openclaw doctor --fix");
  });

  it("does not warn when clawd is still configured as a browser profile", async () => {
    const noteFn = vi.fn();

    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          profiles: {
            clawd: { cdpPort: 18801 },
            openclaw: { cdpPort: 18800 },
          },
        },
      },
      {
        noteFn,
        ...managedHost,
        configDir: "/tmp/openclaw-home",
        pathExists: () => true,
      },
    );

    expect(noteFn).not.toHaveBeenCalled();
  });

  it("warns when Chrome MCP is configured but Chrome is missing", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          defaultProfile: "user",
        },
      },
      {
        noteFn,
        platform: "darwin",
        resolveChromeExecutable: () => null,
      },
    );

    const chromeNote = requireNoteTextContaining(noteFn, "Google Chrome was not found");
    expect(chromeNote).toContain("brave://inspect/#remote-debugging");
    const importNote = requireNoteTextContaining(noteFn, "System browser profile cookie import");
    expect(importNote).toContain("enabled");
    expect(importNote).toContain("System browser profile discovery skipped");
  });

  it.each<{
    name: string;
    browser: NonNullable<Parameters<typeof noteChromeMcpBrowserReadiness>[0]["browser"]>;
    managed: boolean;
    chromeMcp: boolean;
  }>([
    {
      name: "custom default Chrome MCP",
      browser: { defaultProfile: "work", profiles: { work: { driver: "existing-session" } } },
      managed: false,
      chromeMcp: true,
    },
    {
      name: "explicit Chrome MCP endpoint",
      browser: {
        profiles: { endpoint: { driver: "existing-session", cdpUrl: "https://browser.example" } },
      },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "Chrome MCP endpoint arguments",
      browser: {
        profiles: {
          endpoint: {
            driver: "existing-session",
            mcpArgs: Array.of("--browserUrl", "https://browser.example"),
          },
        },
      },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "explicit Chrome MCP auto-connect override",
      browser: {
        profiles: {
          local: {
            driver: "existing-session",
            cdpUrl: "https://browser.example",
            mcpArgs: Array.of("--autoConnect"),
          },
        },
      },
      managed: false,
      chromeMcp: true,
    },
    {
      name: "explicit managed override of user",
      browser: {
        defaultProfile: "user",
        profiles: { user: { driver: "openclaw", cdpPort: 18801 } },
      },
      managed: true,
      chromeMcp: false,
    },
    {
      name: "extension",
      browser: { defaultProfile: "chrome", profiles: { chrome: { driver: "extension" } } },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "remote CDP",
      browser: { profiles: { remote: { cdpUrl: "https://browser.example" } } },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "profile attach-only",
      browser: { profiles: { attached: { cdpPort: 18801, attachOnly: true } } },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "inherited attach-only",
      browser: { attachOnly: true, profiles: { attached: { cdpPort: 18801 } } },
      managed: false,
      chromeMcp: false,
    },
    {
      name: "explicit managed override of inherited attach-only",
      browser: { attachOnly: true, profiles: { local: { cdpPort: 18801, attachOnly: false } } },
      managed: true,
      chromeMcp: false,
    },
    {
      name: "Lightpanda",
      browser: {
        profiles: {
          lightweight: { engine: "lightpanda", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
        },
      },
      managed: false,
      chromeMcp: false,
    },
    { name: "unconfigured built-ins", browser: {}, managed: false, chromeMcp: false },
  ])("checks only launch prerequisites for $name", async ({ browser, managed, chromeMcp }) => {
    const noteFn = vi.fn();
    const resolveManagedExecutable = vi.fn(() => null);
    const resolveChromeExecutable = vi.fn(() => null);
    await noteChromeMcpBrowserReadiness(
      { browser: { headless: false, ...browser, extensionRelay: { allowLegacyAuth: false } } },
      {
        ...managedHost,
        env: {},
        getUid: () => 0,
        noteFn,
        resolveManagedExecutable,
        resolveChromeExecutable,
      },
    );

    const notes = noteFn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(resolveManagedExecutable).toHaveBeenCalledTimes(managed ? 1 : 0);
    expect(resolveChromeExecutable).toHaveBeenCalledTimes(chromeMcp ? 1 : 0);
    expect(notes.includes("No Chromium-based browser executable was found")).toBe(managed);
    expect(notes.includes("No DISPLAY or WAYLAND_DISPLAY is set")).toBe(managed);
    expect(notes.includes("The Gateway is running as root")).toBe(managed);
    expect(notes.includes("Google Chrome was not found")).toBe(chromeMcp);
  });

  it.each([
    { name: "profile headless override", global: false, profile: true, env: {}, warning: false },
    { name: "profile headed override", global: true, profile: false, env: {}, warning: true },
    {
      name: "Linux headless default",
      global: undefined,
      profile: undefined,
      env: {},
      warning: false,
    },
    {
      name: "environment headless override",
      global: false,
      profile: false,
      env: { OPENCLAW_BROWSER_HEADLESS: "1" },
      warning: false,
    },
    {
      name: "environment headed override",
      global: true,
      profile: true,
      env: { OPENCLAW_BROWSER_HEADLESS: "0" },
      warning: true,
    },
  ])("matches managed launch display requirements for $name", async (testCase) => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          headless: testCase.global,
          profiles: { work: { cdpPort: 18801, headless: testCase.profile } },
        },
      },
      { ...managedHost, env: testCase.env, noteFn },
    );

    const notes = noteFn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(notes.includes("DISPLAY") || notes.includes("Linux display server")).toBe(
      testCase.warning,
    );
    if (testCase.warning) {
      expect(notes).toContain(
        testCase.name === "profile headed override"
          ? "browser.profiles.work.headless=false"
          : "OPENCLAW_BROWSER_HEADLESS=0",
      );
    }
  });

  it("checks effective executables once per path and names only profiles missing a browser", async () => {
    const noteFn = vi.fn();
    const resolveManagedExecutable = vi.fn((resolved: { executablePath?: string }) =>
      resolved.executablePath === "/custom/chrome"
        ? { kind: "chrome" as const, path: resolved.executablePath }
        : null,
    );
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          executablePath: "/global/missing-chrome",
          profiles: {
            custom: { cdpPort: 18801, executablePath: "/custom/chrome" },
            fallback: { cdpPort: 18802 },
            shared: { cdpPort: 18803, executablePath: "/custom/chrome" },
          },
        },
      },
      { ...managedHost, noteFn, resolveManagedExecutable },
    );

    expect(
      resolveManagedExecutable.mock.calls.map(([resolved]) => resolved.executablePath),
    ).toEqual(["/custom/chrome", "/global/missing-chrome"]);
    const note = requireNoteTextContaining(noteFn, "No Chromium-based browser executable");
    expect(note).toContain("profile(s) are configured: fallback.");
    expect(note).not.toContain("custom");
    expect(note).not.toContain("shared");
  });

  it("warns when detected Chrome is too old for Chrome MCP", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          profiles: {
            chromeLive: {
              driver: "existing-session",
              color: "#00AA00",
            },
          },
        },
      },
      {
        noteFn,
        platform: "linux",
        resolveChromeExecutable: () => ({ path: "/usr/bin/google-chrome" }),
        readVersion: () => "Google Chrome 143.0.7499.4",
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    const note = requireFirstNoteText(noteFn);
    expect(note).toContain("too old");
    expect(note).toContain("Chrome 144+");
  });

  it("reports the detected Chrome version for existing-session profiles", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          profiles: {
            chromeLive: {
              driver: "existing-session",
              color: "#00AA00",
            },
          },
        },
      },
      {
        noteFn,
        platform: "win32",
        resolveChromeExecutable: () => ({
          path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        }),
        readVersion: () => "Google Chrome 144.0.7534.0",
      },
    );

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(requireFirstNoteText(noteFn)).toContain("Detected Chrome Google Chrome 144.0.7534.0");
  });

  it("skips Chrome auto-detection when profiles use explicit userDataDir", async () => {
    const noteFn = vi.fn();
    await noteChromeMcpBrowserReadiness(
      {
        browser: {
          extensionRelay: { allowLegacyAuth: false },
          profiles: {
            braveLive: {
              driver: "existing-session",
              userDataDir: "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser",
              color: "#FB542B",
            },
          },
        },
      },
      {
        noteFn,
        resolveChromeExecutable: () => {
          throw new Error("should not look up Chrome");
        },
      },
    );

    expect(noteFn).toHaveBeenCalled();
    const note = requireNoteTextContaining(noteFn, "explicit Chromium user data directory");
    expect(note).toContain("brave://inspect/#remote-debugging");
  });
});

describe("legacy clawd browser profile cleanup", () => {
  it("archives stale clawd residue with the safe trash mover", async () => {
    const movePathToTrash = vi.fn(async () => "/tmp/openclaw-home/browser/.trash/clawd");

    const result = await maybeArchiveLegacyClawdBrowserProfileResidue(
      {
        browser: {
          profiles: {
            openclaw: { color: "#FF4500" },
          },
        },
      },
      {
        configDir: "/tmp/openclaw-home",
        pathExists: (targetPath) => targetPath.endsWith("/browser/clawd/user-data"),
        movePathToTrash,
      },
    );

    expect(movePathToTrash).toHaveBeenCalledWith("/tmp/openclaw-home/browser/clawd");
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.join("\n")).toContain(
      "Archived legacy clawd managed browser profile residue.",
    );
    expect(result.changes.join("\n")).toContain("/tmp/openclaw-home/browser/openclaw/user-data");
  });

  it("does not archive a configured clawd browser profile", async () => {
    const movePathToTrash = vi.fn(async () => "/tmp/unused");

    const result = await maybeArchiveLegacyClawdBrowserProfileResidue(
      {
        browser: {
          defaultProfile: "clawd",
          profiles: {
            clawd: { color: "#FF4500" },
          },
        },
      },
      {
        configDir: "/tmp/openclaw-home",
        pathExists: () => true,
        movePathToTrash,
      },
    );

    expect(movePathToTrash).not.toHaveBeenCalled();
    expect(result).toStrictEqual({ changes: [], warnings: [] });
  });
});
