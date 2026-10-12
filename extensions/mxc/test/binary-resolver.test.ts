import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock node:fs and node:os for controlled testing
const { existsSyncMock, homedirMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  homedirMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: homedirMock,
}));

import { resolveMxcBinaryPath } from "../src/binary-resolver.js";

describe("resolveMxcBinaryPath", () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    existsSyncMock.mockReset();
    homedirMock.mockReturnValue("/home/openclaw");
    process.env.PATH = "";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test("config override returns the override path when file exists", () => {
    existsSyncMock.mockReturnValue(true);
    const result = resolveMxcBinaryPath("C:\\custom\\wxc-exec.exe");
    expect(result).toBe("C:\\custom\\wxc-exec.exe");
  });

  test("config override returns an absolute path for relative inputs", () => {
    const relativeOverride = path.join("tools", "wxc-exec.exe");
    const absoluteOverride = path.resolve(relativeOverride);
    existsSyncMock.mockImplementation((candidate) => candidate === absoluteOverride);

    expect(resolveMxcBinaryPath(relativeOverride)).toBe(absoluteOverride);
  });

  test("config override throws when file does not exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => resolveMxcBinaryPath("C:\\missing\\wxc-exec.exe")).toThrow(
      /not found at configured path/,
    );
  });

  test("ignores project, PATH, and home candidates during discovery", () => {
    const projectCandidate = path.join(process.cwd(), "bin", "wxc-exec.exe");
    const homeCandidate = path.join("/home/openclaw", ".mxc", "wxc-exec.exe");
    const trustedDir = "/trusted-path";
    const pathCandidate = path.join(trustedDir, "wxc-exec.exe");
    process.env.PATH = trustedDir;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      return [projectCandidate, homeCandidate, pathCandidate].includes(candidatePath);
    });

    expect(() => resolveMxcBinaryPath()).toThrow(/wxc-exec\.exe.*not found/u);
  });

  test("resolves the SDK arch binary", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    let sdkCandidate: string | undefined;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      if (candidatePath.endsWith(`${path.sep}bin${path.sep}${arch}`)) {
        return true;
      }
      if (candidatePath.endsWith(`${path.sep}bin${path.sep}${arch}${path.sep}wxc-exec.exe`)) {
        sdkCandidate = candidatePath;
        return true;
      }
      return false;
    });

    expect(resolveMxcBinaryPath()).toBe(sdkCandidate);
  });

  test("falls back to SDK flat bin when arch bin is absent", () => {
    let sdkCandidate: string | undefined;
    existsSyncMock.mockImplementation((candidate) => {
      const candidatePath = String(candidate);
      if (candidatePath.endsWith(`${path.sep}bin`)) {
        return true;
      }
      if (candidatePath.endsWith(`${path.sep}bin${path.sep}wxc-exec.exe`)) {
        sdkCandidate = candidatePath;
        return true;
      }
      return false;
    });

    expect(resolveMxcBinaryPath()).toBe(sdkCandidate);
  });
});
