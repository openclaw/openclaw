import { describe, expect, it } from "vitest";
import { resolveSandboxPath } from "./sandbox-paths.js";

describe("resolveSandboxPath", () => {
  const root = "/workspace";
  const cwd = "/workspace";

  it("allows paths within root", () => {
    const result = resolveSandboxPath({
      filePath: "subdir/file.txt",
      cwd,
      root,
    });
    expect(result.resolved).toBe("/workspace/subdir/file.txt");
    expect(result.relative).toBe("subdir/file.txt");
    expect(result.base).toBe("/workspace");
  });

  it("rejects paths escaping root without allowedPaths", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: "/other/path/file.txt",
        cwd,
        root,
      }),
    ).toThrow(/escapes sandbox root/);
  });

  it("allows paths in allowedPaths when they escape root", () => {
    // /external/skills is outside /workspace, but allowed via allowedPaths
    const result = resolveSandboxPath({
      filePath: "/external/skills/tameson/SKILL.md",
      cwd,
      root,
      allowedPaths: ["/external/skills"],
    });
    expect(result.resolved).toBe("/external/skills/tameson/SKILL.md");
    expect(result.relative).toBe("tameson/SKILL.md");
    expect(result.base).toBe("/external/skills");
  });

  it("still rejects paths not in root or allowedPaths", () => {
    expect(() =>
      resolveSandboxPath({
        filePath: "/etc/passwd",
        cwd,
        root,
        allowedPaths: ["/external/skills"],
      }),
    ).toThrow(/escapes sandbox root/);
  });

  it("allows exact match of allowedPath", () => {
    const result = resolveSandboxPath({
      filePath: "/external/skills",
      cwd,
      root,
      allowedPaths: ["/external/skills"],
    });
    expect(result.resolved).toBe("/external/skills");
    expect(result.relative).toBe("");
    expect(result.base).toBe("/external/skills");
  });

  it("prefers root over allowedPaths for paths inside root", () => {
    // Path is inside root - should use root as base, not allowedPaths
    const result = resolveSandboxPath({
      filePath: "/workspace/file.txt",
      cwd,
      root,
      allowedPaths: ["/workspace"], // redundant, but shouldn't matter
    });
    expect(result.base).toBe("/workspace");
    expect(result.relative).toBe("file.txt");
  });

  it("handles multiple allowedPaths", () => {
    const result = resolveSandboxPath({
      filePath: "/data/files/test.txt",
      cwd,
      root,
      allowedPaths: ["/external/skills", "/data/files"],
    });
    expect(result.resolved).toBe("/data/files/test.txt");
    expect(result.relative).toBe("test.txt");
    expect(result.base).toBe("/data/files");
  });
});
