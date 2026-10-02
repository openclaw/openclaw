import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readBrowserVersion } from "./chrome.executable-probe.js";

describe.runIf(process.platform === "win32")("Windows browser version probe", () => {
  let fixtureRoot = "";

  function makeInstallDir(browserName: string): string {
    const installDir = path.join(fixtureRoot, "Program Files", browserName, "Application");
    fs.mkdirSync(installDir, { recursive: true });
    return installDir;
  }

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-probe-"));
    // Pay PowerShell's cold start outside the probe's production timeout.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
      timeout: 60_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("reads PE metadata from an install path with spaces without writing to stderr", () => {
    // node.exe carries real PE version metadata, like an installed browser.
    const executablePath = path.join(makeInstallDir("Google Chrome"), "chrome.exe");
    fs.copyFileSync(process.execPath, executablePath);
    const stderrWrite = vi.spyOn(process.stderr, "write");

    const version = readBrowserVersion(executablePath);

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(version).toContain(process.versions.node);
  });

  it("keeps a failed metadata probe quiet before the version directory fallback", () => {
    // GetVersionInfo throws for a missing file, so PowerShell exits with an error record.
    const installDir = makeInstallDir("Missing Browser");
    fs.mkdirSync(path.join(installDir, "148.0.7778.179"));
    const stderrWrite = vi.spyOn(process.stderr, "write");

    const version = readBrowserVersion(path.join(installDir, "chrome.exe"));

    expect(stderrWrite).not.toHaveBeenCalled();
    expect(version).toBe("148.0.7778.179");
  });
});
