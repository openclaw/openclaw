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

function withBinds(binds: string[], overrides?: Partial<SandboxContext>) {
  return createSandbox({ ...overrides, docker: { ...createSandbox().docker, binds } });
}

function resolve(sandbox: SandboxContext, filePath: string) {
  return resolveSandboxFsPathWithMounts({
    filePath,
    cwd: sandbox.workspaceDir,
    defaultWorkspaceRoot: sandbox.workspaceDir,
    defaultContainerRoot: sandbox.containerWorkdir,
    mounts: buildSandboxFsMounts(sandbox),
  });
}

const readonlyChild = ["/tmp/data:/tmp/data:rw", "/tmp/data/secrets:/tmp/data/secrets:ro"];
const writableChild = [
  "/tmp/readonly-parent:/tmp/readonly-parent:ro",
  "/tmp/readonly-parent/work:/tmp/readonly-parent/work:rw",
];
const nonHomeWorkspace = path.join(path.parse(os.homedir()).root, "openclaw-non-home-workspace");

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
    expect(resolveWritableSandboxBindHostRoots([...readonlyChild, ...writableChild])).toEqual([
      path.resolve("/tmp/readonly-parent/work"),
    ]);
  });

  it("detects bind mounts whose container path differs from the host path", () => {
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/tmp/data:rw"])).toBe(
      process.platform === "win32",
    );
    expect(hasSandboxBindContainerPathAliases(["/tmp/data:/data:rw"])).toBe(true);
    expect(hasSandboxBindContainerPathAliases(["invalid-bind"])).toBe(false);
  });

  it("detects read-only bind shadows inside writable host roots", () => {
    expect(hasSandboxBindReadonlyHostShadows(readonlyChild)).toBe(true);
    expect(hasSandboxBindReadonlyHostShadows(writableChild)).toBe(false);
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
      expect(resolve(sandbox, filePath)).toMatchObject({
        hostPath: path.resolve(sandbox.workspaceDir, "a\\b"),
        containerPath: `/workspace/${relativePath}`,
        relativePath,
        writable: true,
      });
    }
  });

  it.each([
    "@marker",
    "@/workspace/marker",
    "~/workspace-coder/marker",
    `@${path.join(os.homedir(), "workspace-coder", "marker")}`,
  ])("normalizes %s before selecting workspace intent", (filePath) => {
    const workspaceDir = path.join(os.homedir(), "workspace-coder");
    const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
    expect(resolve(sandbox, filePath)).toMatchObject({
      hostPath: path.join(workspaceDir, "marker"),
      containerPath: "/workspace/marker",
    });
  });

  it("rejects Windows absolute paths outside mounted roots on every host platform", () => {
    const sandbox = createSandbox();
    for (const filePath of ["C:\\outside\\secret.txt", "C:/outside/secret.txt"]) {
      expect(() => resolve(sandbox, filePath)).toThrow("Path escapes sandbox root");
    }
  });

  it.runIf(process.platform === "win32")(
    "keeps case-equivalent workspace input aliases ahead of other binds",
    () => {
      const workspaceDir = "C:\\Project\\Work";
      const replacement = "C:\\Replacement";
      const sandbox = withBinds(["c:\\project\\work:/data:rw", `${replacement}:/workspace:ro`], {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
      });
      for (const filePath of ["marker", "C:\\Project\\Work\\marker", "/workspace/marker"]) {
        expect(resolve(sandbox, filePath)).toMatchObject({
          hostPath: path.join(replacement, "marker"),
          containerPath: "/workspace/marker",
          writable: false,
        });
      }
      expect(resolve(sandbox, "/data/marker")).toMatchObject({
        hostPath: "c:\\project\\work\\marker",
        containerPath: "/data/marker",
        writable: true,
      });
    },
  );

  it.each([
    [path.join(os.homedir(), "workspace-coder"), "~/workspace-coder", "/workspace"],
    [path.join(os.homedir(), "workspace-coder"), "~/workspace-coder", "/sandbox-root"],
    [nonHomeWorkspace, nonHomeWorkspace, "/workspace"],
  ])("reports escape from %s under %s using %s", (workspaceDir, displayRoot, containerWorkdir) => {
    const sandbox = createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      containerWorkdir,
      docker: { ...createSandbox().docker, workdir: containerWorkdir },
    });
    expect(() => resolve(sandbox, "/tmp/outside")).toThrow(
      new Error(
        `Path escapes sandbox root (${displayRoot}; container root ${containerWorkdir}): /tmp/outside. Use a path under ${containerWorkdir}/ instead.`,
      ),
    );
  });

  it.runIf(process.platform === "win32")("redacts Windows home casing aliases", () => {
    const homeAlias = os.homedir().toUpperCase();
    expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
    const workspaceDir = path.join(homeAlias, "workspace-coder");
    const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
    expect(() => resolve(sandbox, "C:\\outside\\secret.txt")).toThrow(
      "Path escapes sandbox root (~/workspace-coder; container root /workspace)",
    );
  });
});
