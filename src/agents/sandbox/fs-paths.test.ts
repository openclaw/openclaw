import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxContext } from "./types.js";
import {
  buildSandboxFsMounts,
  parseSandboxBindMount,
  resolveSandboxFsPathWithMounts,
} from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({ overrides });
}

describe("parseSandboxBindMount", () => {
  it("parses bind mode and writeability", () => {
    expect(parseSandboxBindMount("/tmp/a:/workspace-a:ro")).toEqual({
      hostRoot: path.resolve("/tmp/a"),
      containerRoot: "/workspace-a",
      writable: false,
    });
    expect(parseSandboxBindMount("/tmp/b:/workspace-b:rw")).toEqual({
      hostRoot: path.resolve("/tmp/b"),
      containerRoot: "/workspace-b",
      writable: true,
    });
  });
});

describe("resolveSandboxFsPathWithMounts", () => {
  it("maps mounted container absolute paths to host paths", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      filePath: "/workspace-two/docs/AGENTS.md",
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts,
    });

    expect(resolved.hostPath).toBe(
      path.join(path.resolve("/tmp/workspace-two"), "docs", "AGENTS.md"),
    );
    expect(resolved.containerPath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.relativePath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.writable).toBe(false);
  });

  it("keeps workspace-relative display paths for default workspace files", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      filePath: "src/index.ts",
      cwd: sandbox.workspaceDir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      mounts,
    });
    expect(resolved.hostPath).toBe(path.join(path.resolve("/tmp/workspace"), "src", "index.ts"));
    expect(resolved.containerPath).toBe("/workspace/src/index.ts");
    expect(resolved.relativePath).toBe("src/index.ts");
    expect(resolved.writable).toBe(true);
  });

  it("preserves legacy sandbox-root error for outside paths", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    expect(() =>
      resolveSandboxFsPathWithMounts({
        filePath: "/etc/passwd",
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      }),
    ).toThrow(/Path escapes sandbox root/);
  });
});
