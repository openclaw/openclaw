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

import { readBrowserVersion } from "./chrome.executables.js";

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

  // Regression for #87312: `chrome.exe --version` prints nothing to stdout on
  // Windows, so the version must come from the install layout / file metadata.
  describe("on Windows", () => {
    function makeWindowsChromeDir(versionDirs: string[]): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chrome-win-"));
      const appDir = path.join(root, "Application");
      fs.mkdirSync(appDir, { recursive: true });
      for (const name of versionDirs) {
        fs.mkdirSync(path.join(appDir, name));
      }
      fs.writeFileSync(path.join(appDir, "chrome.exe"), "");
      return appDir;
    }

    it("derives the version from the newest sibling build directory", () => {
      stubPlatform("win32");
      // Numeric ordering must win over lexical (lexical would pick "99.*").
      const appDir = makeWindowsChromeDir(["99.0.1.1", "147.0.7390.54", "148.0.7778.179"]);
      try {
        expect(readBrowserVersion(path.join(appDir, "chrome.exe"))).toBe("148.0.7778.179");
        // No PowerShell spawn when a version directory is found.
        expect(execFileSyncMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(path.dirname(appDir), { recursive: true, force: true });
      }
    });

    it("falls back to file metadata via PowerShell when no version directory exists", () => {
      stubPlatform("win32");
      const appDir = makeWindowsChromeDir([]);
      execFileSyncMock.mockReturnValue("148.0.7778.179\r\n");
      try {
        const exePath = path.join(appDir, "chrome.exe");
        expect(readBrowserVersion(exePath)).toBe("148.0.7778.179");
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
        const [command, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
        expect(command).toBe("powershell.exe");
        expect(args.at(-1)).toContain("VersionInfo.ProductVersion");
        expect(args.at(-1)).toContain(exePath);
      } finally {
        fs.rmSync(path.dirname(appDir), { recursive: true, force: true });
      }
    });

    it("returns null when neither a version directory nor file metadata is available", () => {
      stubPlatform("win32");
      const appDir = makeWindowsChromeDir([]);
      execFileSyncMock.mockReturnValue("");
      try {
        expect(readBrowserVersion(path.join(appDir, "chrome.exe"))).toBeNull();
      } finally {
        fs.rmSync(path.dirname(appDir), { recursive: true, force: true });
      }
    });
  });
});
