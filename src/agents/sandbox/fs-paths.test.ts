// Sandbox filesystem path tests cover bind parsing, host/container path mapping,
// and writable-root detection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxFsMounts,
  hasSandboxBindContainerPathAliases,
  hasSandboxBindReadonlyHostShadows,
  resolveSandboxFsPathWithMounts,
  resolveWritableSandboxBindHostRoots,
} from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({ overrides });
}

describe("sandbox bind mounts", () => {
  it("returns only unique writable bind host roots", () => {
    expect(
      resolveWritableSandboxBindHostRoots([
        "/tmp/data:/data:rw",
        "/tmp/read-only:/read-only:ro",
        "/tmp/default-write:/default-write",
        "/tmp/data:/data-two:rw",
        "C:\\Users\\kai\\workspace:/windows-read-only:ro",
        "D:/data:/windows-data:rw",
        "//server/share:/unc-share:rw",
        "invalid-bind",
      ]),
    ).toEqual([
      path.resolve("/tmp/data"),
      path.resolve("/tmp/default-write"),
      path.resolve("D:/data"),
      path.resolve("//server/share"),
    ]);
  });

  it("omits writable bind roots that contain read-only host shadows", () => {
    // A writable parent with a read-only child is unsafe for generic host writes;
    // callers must route through mount-aware path resolution instead.
    expect(
      resolveWritableSandboxBindHostRoots([
        "/tmp/data:/tmp/data:rw",
        "/tmp/data/secrets:/tmp/data/secrets:ro",
        "/tmp/readonly-parent:/tmp/readonly-parent:ro",
        "/tmp/readonly-parent/work:/tmp/readonly-parent/work:rw",
      ]),
    ).toEqual([path.resolve("/tmp/readonly-parent/work")]);
  });

  it("detects bind mounts whose container path differs from the host path", () => {
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/tmp/data:rw"])).toBe(
      process.platform === "win32",
    );
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/data:rw"])).toBe(true);
    expect(hasSandboxBindContainerPathAliases(["invalid-bind"])).toBe(false);
  });

  it("detects read-only bind shadows inside writable host roots", () => {
    expect(
      hasSandboxBindReadonlyHostShadows([
        "/tmp/data:/tmp/data:rw",
        "/tmp/data/secrets:/tmp/data/secrets:ro",
      ]),
    ).toBe(true);
    expect(
      hasSandboxBindReadonlyHostShadows([
        "/tmp/data:/tmp/data:ro",
        "/tmp/data/work:/tmp/data/work:rw",
      ]),
    ).toBe(false);
  });
});

describe("resolveSandboxFsPathWithMounts", () => {
  it("converts only native separators when mapping workspace-relative paths", () => {
    const sandbox = createSandbox();
    const relativePath = process.platform === "win32" ? "a/b" : "a\\b";
    for (const filePath of [
      "a\\b",
      `/workspace/${relativePath}`,
      path.resolve(sandbox.workspaceDir, "a\\b"),
    ]) {
      expect(
        resolveSandboxFsPathWithMounts({
          filePath,
          cwd: sandbox.workspaceDir,
          defaultWorkspaceRoot: sandbox.workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts: buildSandboxFsMounts(sandbox),
        }),
      ).toMatchObject({
        hostPath: path.resolve(sandbox.workspaceDir, "a\\b"),
        containerPath: `/workspace/${relativePath}`,
        relativePath,
      });
    }
  });

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

  it("normalizes home and @-prefixed host inputs through the selected workspace", () => {
    const workspaceDir = path.join(os.homedir(), "workspace-coder");
    const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
    for (const filePath of ["~/workspace-coder/marker", `@${path.join(workspaceDir, "marker")}`]) {
      const resolved = resolveSandboxFsPathWithMounts({
        filePath,
        cwd: workspaceDir,
        defaultWorkspaceRoot: workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts: buildSandboxFsMounts(sandbox),
      });
      expect(resolved.hostPath).toBe(path.join(workspaceDir, "marker"));
      expect(resolved.containerPath).toBe("/workspace/marker");
    }
  });

  it("rejects Windows absolute paths outside mounted roots on every host platform", () => {
    const sandbox = createSandbox();
    for (const filePath of ["C:\\outside\\secret.txt", "C:/outside/secret.txt"]) {
      expect(() =>
        resolveSandboxFsPathWithMounts({
          filePath,
          cwd: sandbox.workspaceDir,
          defaultWorkspaceRoot: sandbox.workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts: buildSandboxFsMounts(sandbox),
        }),
      ).toThrow("Path escapes sandbox root");
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves Windows drive-qualified workspace inputs",
    () => {
      const workspaceDir = path.join(os.homedir(), "workspace-coder");
      const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
      const resolved = resolveSandboxFsPathWithMounts({
        filePath: path.join(workspaceDir, "marker"),
        cwd: workspaceDir,
        defaultWorkspaceRoot: workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts: buildSandboxFsMounts(sandbox),
      });
      expect(resolved.hostPath).toBe(path.join(workspaceDir, "marker"));
      expect(resolved.containerPath).toBe("/workspace/marker");
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps case-equivalent workspace input aliases ahead of other binds",
    () => {
      const workspaceDir = "C:\\Project\\Work";
      const replacement = "C:\\Replacement";
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        docker: {
          ...createSandbox().docker,
          binds: ["c:\\project\\work:/data:rw", `${replacement}:/workspace:ro`],
        },
      });
      const resolve = (filePath: string) =>
        resolveSandboxFsPathWithMounts({
          filePath,
          cwd: workspaceDir,
          defaultWorkspaceRoot: workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts: buildSandboxFsMounts(sandbox),
        });
      for (const filePath of ["marker", "C:\\Project\\Work\\marker", "/workspace/marker"]) {
        expect(resolve(filePath)).toMatchObject({
          hostPath: path.join(replacement, "marker"),
          containerPath: "/workspace/marker",
          writable: false,
        });
      }
      expect(resolve("/data/marker")).toMatchObject({
        hostPath: "c:\\project\\work\\marker",
        containerPath: "/data/marker",
        writable: true,
      });
    },
  );

  it("includes container workspace hint without exposing a full home workspace root", () => {
    // Error messages should guide users toward container paths without printing
    // the host home directory.
    const workspaceDir = path.join(os.homedir(), "workspace-coder");
    const sandbox = createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    });
    const mounts = buildSandboxFsMounts(sandbox);
    let thrown: unknown;
    try {
      resolveSandboxFsPathWithMounts({
        filePath: "/tmp/outside",
        cwd: sandbox.workspaceDir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        mounts,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(
      "Path escapes sandbox root (~/workspace-coder; container root /workspace): /tmp/outside",
    );
    expect(message).toContain("Use a path under /workspace/ instead.");
    expect(message).not.toContain(os.homedir());
  });

  it.skipIf(process.platform !== "win32")(
    "does not expose real Windows home casing aliases in escape errors",
    () => {
      const homeAlias = os.homedir().toUpperCase();
      expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
      const workspaceDir = path.join(homeAlias, "workspace-coder");
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
      });

      expect(() =>
        resolveSandboxFsPathWithMounts({
          filePath: "C:\\outside\\secret.txt",
          cwd: sandbox.workspaceDir,
          defaultWorkspaceRoot: sandbox.workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts: buildSandboxFsMounts(sandbox),
        }),
      ).toThrow("Path escapes sandbox root (~/workspace-coder; container root /workspace)");
    },
  );
});
