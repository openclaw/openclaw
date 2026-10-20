import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

import { parseBrowserMajorVersion, readBrowserVersion } from "./chrome.executable-probe.js";

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("readBrowserVersion", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    stubPlatform(originalPlatform);
    execFileSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("parses odd dotted browser version tokens using the last match", () => {
    expect(parseBrowserMajorVersion("Chromium 3.0/1.2.3")).toBe(1);
  });

  it("returns null when no dotted version token exists", () => {
    expect(parseBrowserMajorVersion("no version here")).toBeNull();
  });

  it("reads macOS app bundle versions from Info.plist before spawning Chrome", () => {
    stubPlatform("darwin");
    execFileSyncMock.mockReturnValue("148.0.7778.179\n");

    const version = readBrowserVersion(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );

    expect(version).toBe("148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleShortVersionString",
        "/Applications/Google Chrome.app/Contents/Info.plist",
      ],
      expect.objectContaining({ timeout: 800 }),
    );
  });

  it("falls back to a slower --version probe when macOS bundle metadata is unavailable", () => {
    stubPlatform("darwin");
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error("plist unavailable");
      })
      .mockReturnValueOnce("Google Chrome 148.0.7778.179\n");

    const version = readBrowserVersion(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );

    expect(version).toBe("Google Chrome 148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--version"],
      expect.objectContaining({ timeout: 6000 }),
    );
  });

  it("uses the slower --version probe for non-bundle paths", () => {
    stubPlatform("darwin");
    execFileSyncMock.mockReturnValue("Chromium 148.0.7778.179\n");

    const version = readBrowserVersion("/opt/chromium/chrome");

    expect(version).toBe("Chromium 148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/opt/chromium/chrome",
      ["--version"],
      expect.objectContaining({ timeout: 6000 }),
    );
  });

  describe("on Windows", () => {
    function withWindowsChromeDir(versionDirs: string[], run: (appDir: string) => void): void {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chrome-win-"));
      const appDir = path.join(root, "Application");
      stubPlatform("win32");
      try {
        fs.mkdirSync(appDir, { recursive: true });
        for (const name of versionDirs) {
          fs.mkdirSync(path.join(appDir, name));
        }
        fs.writeFileSync(path.join(appDir, "chrome.exe"), "");
        run(appDir);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    it("reads PE product metadata with the executable path passed as environment data", () => {
      stubPlatform("win32");
      const exePath = "C:\\Users\\Example\\Browser's Path\\chrome.exe";
      execFileSyncMock.mockReturnValue("148.0.7778.179\r\n");

      expect(readBrowserVersion(exePath)).toBe("148.0.7778.179");
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const powershellPath = path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      expect(path.win32.isAbsolute(powershellPath)).toBe(true);
      expect(execFileSyncMock).toHaveBeenCalledWith(
        powershellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:OPENCLAW_BROWSER_EXECUTABLE_PATH).ProductVersion",
        ],
        expect.objectContaining({
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
          env: expect.objectContaining({ OPENCLAW_BROWSER_EXECUTABLE_PATH: exePath }),
        }),
      );
    });

    it("falls back to one unambiguous version directory", () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error("PowerShell unavailable");
      });
      withWindowsChromeDir(["148.0.7778.179"], (appDir) => {
        fs.writeFileSync(path.join(appDir, "149.0.0.0"), "not a directory");
        expect(readBrowserVersion(path.join(appDir, "chrome.exe"))).toBe("148.0.7778.179");
      });
    });

    it("returns null with multiple version directories after metadata lookup fails", () => {
      execFileSyncMock.mockReturnValue("");
      withWindowsChromeDir(["147.0.0.0", "148.0.0.0"], (appDir) => {
        expect(readBrowserVersion(path.join(appDir, "chrome.exe"))).toBeNull();
      });
    });
  });
});
