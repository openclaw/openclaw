import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseBrowserMajorVersion,
  resolveBrowserExecutableForPlatform,
  resolveGoogleChromeExecutableForPlatform,
} from "./chrome.executables.js";

describe("chrome executables", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses odd dotted browser version tokens using the last match", () => {
    expect(parseBrowserMajorVersion("Chromium 3.0/1.2.3")).toBe(1);
  });

  it("returns null when no dotted version token exists", () => {
    expect(parseBrowserMajorVersion("no version here")).toBeNull();
  });

  it("classifies beta Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-beta";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    });
  });

  it("classifies unstable Linux Google Chrome builds as canary", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === "/usr/bin/google-chrome-unstable";
    });

    expect(resolveGoogleChromeExecutableForPlatform("linux")).toEqual({
      kind: "canary",
      path: "/usr/bin/google-chrome-unstable",
    });
  });

  it("expands tilde paths in browser.executablePath", () => {
    const homeDir = os.homedir();
    const tildePath = `/.local/chromium/chrome`;
    const absolutePath = `${homeDir}${tildePath}`;

    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === absolutePath;
    });

    const result = resolveBrowserExecutableForPlatform(
      { executablePath: `~${tildePath}` } as never,
      "linux",
    );
    expect(result).toEqual({ kind: "custom", path: absolutePath });
  });

  it("passes through non-tilde executablePath unchanged", () => {
    const absolutePath = "/opt/chromium/chrome";

    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      return String(candidate) === absolutePath;
    });

    const result = resolveBrowserExecutableForPlatform(
      { executablePath: absolutePath } as never,
      "linux",
    );
    expect(result).toEqual({ kind: "custom", path: absolutePath });
  });
});
