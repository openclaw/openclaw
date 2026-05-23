import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const resolveSandboxInputPathMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox-paths.js", () => ({
  resolveSandboxInputPath: resolveSandboxInputPathMock,
}));

import {
  normalizeBoundaryRoots,
  resolvePathWithinRoots,
  toRelativeWorkspacePath,
} from "./path-policy.js";

describe("toRelativeWorkspacePath (windows semantics)", () => {
  beforeEach(() => {
    resolveSandboxInputPathMock.mockReset();
    resolveSandboxInputPathMock.mockImplementation((filePath: string) => filePath);
  });

  it("accepts windows paths with mixed separators and case", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:/users/user/openclaw/memory/log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("memory\\log.txt");
    });
  });

  it("rejects windows paths outside workspace root", () => {
    withMockedWindowsPlatform(() => {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
    });
  });
});

describe("toRelativeWorkspacePath", () => {
  it("accepts dot-dot-prefixed filenames inside the workspace", () => {
    expect(toRelativeWorkspacePath("/workspace/root", "/workspace/root/..file.txt")).toBe(
      "..file.txt",
    );
  });

  it("rejects parent directory traversal outside the workspace", () => {
    expect(() => toRelativeWorkspacePath("/workspace/root", "/workspace/root/../file.txt")).toThrow(
      "Path escapes workspace root",
    );
  });

  it("uses sandbox input normalization for win32 candidate resolution", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      resolveSandboxInputPathMock.mockImplementation(
        (filePath: string, cwd: string) =>
          filePath === "~/file.txt" ? "C:\\Users\\User\\OpenClaw\\file.txt" : path.win32.resolve(cwd, filePath),
      );
      const match = resolvePathWithinRoots(["C:\\Users\\User\\OpenClaw"], "~/file.txt", {
        cwd: "C:\\Users\\User\\OpenClaw",
      });
      expect(match).toEqual({
        root: "C:\\Users\\User\\OpenClaw",
        resolved: "C:\\Users\\User\\OpenClaw\\file.txt",
        relative: "file.txt",
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prefers the most specific matching root", () => {
    const match = resolvePathWithinRoots(
      ["/tmp/workspace", "/tmp/workspace/repos/project"],
      "/tmp/workspace/repos/project/src/index.ts",
    );
    expect(match).toEqual({
      root: "/tmp/workspace/repos/project",
      resolved: "/tmp/workspace/repos/project/src/index.ts",
      relative: "src/index.ts",
    });
  });

  it("normalizes and deduplicates boundary roots", () => {
    expect(
      normalizeBoundaryRoots(["/tmp/workspace", "/tmp/workspace", "/tmp/workspace/."]),
    ).toEqual(["/tmp/workspace"]);
  });
});
