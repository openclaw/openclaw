import { beforeEach, describe, expect, it, vi } from "vitest";

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
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "c:/users/user/openclaw/memory/log.txt";
      expect(toRelativeWorkspacePath(root, candidate)).toBe("memory\\log.txt");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("rejects windows paths outside workspace root", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const root = "C:\\Users\\User\\OpenClaw";
      const candidate = "C:\\Users\\User\\Other\\log.txt";
      expect(() => toRelativeWorkspacePath(root, candidate)).toThrow("Path escapes workspace root");
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
