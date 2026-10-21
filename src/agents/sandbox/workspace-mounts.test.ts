import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceMounts,
  resolveSandboxMountSelection,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

function workspaceMounts(
  workspaceDir: string,
  overrides: Partial<Parameters<typeof resolveWorkspaceMounts>[0]> = {},
) {
  return resolveWorkspaceMounts({
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    workdir: "/workspace",
    workspaceAccess: "rw",
    ...overrides,
  }).map((mount) => `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro,z" : "z"}`);
}

function addSkill(workspaceDir: string, root = "skills") {
  const dir = path.join(workspaceDir, root, "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "# Demo\n");
}

const tmpDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sandbox-mounts-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkspaceMounts", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace:z" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro,z" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:z" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const mounts = workspaceMounts("/tmp/workspace", {
      agentWorkspaceDir: "/tmp/agent-workspace",
      workspaceAccess: access,
    });

    expect(mounts).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const workspaceDir = makeTempWorkspace();
    const agentWorkspaceDir = makeTempWorkspace();
    const mounts = workspaceMounts(workspaceDir, {
      agentWorkspaceDir,
      workspaceAccess: "none",
    });

    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const workspaceDir = makeTempWorkspace();
    const mounts = workspaceMounts(workspaceDir);
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const mounts = workspaceMounts("/tmp/workspace", {
      agentWorkspaceDir: "/tmp/agent-workspace",
      workspaceAccess: "ro",
    });

    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });

  it("overlays workspace skills read-only when workspaceAccess is rw", () => {
    // The writable workspace mount is followed by a narrower read-only skills
    // overlay so sandboxed agents cannot mutate checked-in skill instructions.
    const agentWorkspaceDir = makeTempWorkspace();
    addSkill(agentWorkspaceDir);
    const mounts = workspaceMounts(agentWorkspaceDir);
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    ]);
  });

  it.runIf(process.platform !== "win32")("does not overlay symlinked workspace skill roots", () => {
    // Skill overlays must be real workspace directories; symlinks could expose
    // arbitrary host paths read-only inside the sandbox.
    const agentWorkspaceDir = makeTempWorkspace();
    const outsideDir = makeTempWorkspace();
    fs.mkdirSync(path.join(outsideDir, "demo"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, "skills"), "dir");

    const mounts = workspaceMounts(agentWorkspaceDir);
    expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
  });

  it.runIf(process.platform !== "win32")(
    "does not overlay skill roots through a symlinked parent",
    () => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      fs.mkdirSync(path.join(outsideDir, "skills", "demo"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, ".agents"), "dir");

      const mounts = workspaceMounts(agentWorkspaceDir);
      expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    },
  );

  it("overlays project .agents skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    addSkill(agentWorkspaceDir, ".agents/skills");
    const mounts = workspaceMounts(agentWorkspaceDir);
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });

  it("overlays materialized sandbox skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = makeTempWorkspace();
    const materializedSkillsDir = path.join(skillsWorkspaceDir, "skills");
    addSkill(skillsWorkspaceDir);
    const mounts = workspaceMounts(agentWorkspaceDir, { skillsWorkspaceDir });
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${materializedSkillsDir}:/workspace/.openclaw/sandbox-skills/skills:ro,z`,
    ]);
  });

  it("does not add a separate synced skill overlay when workspaceAccess is ro", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });

    const mounts = workspaceMounts(sandboxWorkspaceDir, {
      agentWorkspaceDir,
      workspaceAccess: "ro",
    });

    expect(mounts).toEqual([
      `${sandboxWorkspaceDir}:/workspace:ro,z`,
      `${agentWorkspaceDir}:/agent:ro,z`,
    ]);
    expect(mounts).not.toContain(
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    );
  });

  it("keeps private workspace skills read-only without exposing the agent workspace", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });
    fs.mkdirSync(path.join(sandboxWorkspaceDir, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(agentWorkspaceDir, "skills", "host-only"), { recursive: true });

    const mounts = workspaceMounts(sandboxWorkspaceDir, {
      agentWorkspaceDir,
      workspaceAccess: "none",
    });

    expect(mounts).toEqual([
      `${sandboxWorkspaceDir}:/workspace:z`,
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
      `${path.join(sandboxWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });
});

describe("resolveSandboxMountSelection", () => {
  const skillA = "/host/a:/workspace/skills:ro";
  const skillB = "/host/b:/workspace/.agents/skills:ro";
  const customSkill = "/host/custom:/workspace/skills:rw";
  const data = "/host/c:/data:rw";
  const otherData = "/host/other:/data:rw";
  const others = ["/host/a:/data:rw", "/host/b:/tmp:ro"];
  const noOptions = "/host/custom:/workspace/skills";
  const trailingSlash = `${noOptions}/`;
  const protectedMounts: ReadOnlyWorkspaceSkillMount[] = [
    { hostPath: "/host/skills", containerPath: "/workspace/skills" },
    { hostPath: "/host/.agents/skills", containerPath: "/workspace/./.agents/skills/" },
  ];

  function select(binds?: readonly string[], readOnlyResourceMounts = protectedMounts) {
    const workspaceDir = makeTempWorkspace();
    const selection = resolveSandboxMountSelection({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
      binds,
      readOnlyResourceMounts,
    });
    return { workspaceDir, ...selection };
  }

  it("selects only the workspace when no binds or protected mounts exist", () => {
    const selection = select(undefined, []);
    expect(selection.custom).toEqual([]);
    expect(selection.skippedBinds).toEqual([]);
    expect(selection.mounts).toEqual([
      {
        hostPath: selection.workspaceDir,
        containerPath: "/workspace",
        readOnly: false,
        source: "workspace",
      },
    ]);
  });

  it("keeps user binds when no protected mounts exist", () => {
    const binds = [customSkill];
    const selection = select(binds, []);
    expect(selection.custom).toEqual(binds);
    expect(selection.skippedBinds).toEqual([]);
    expect(selection.mounts).toContainEqual({
      hostPath: "/host/custom",
      containerPath: "/workspace/skills",
      readOnly: false,
      source: "bind",
    });
  });

  it.each([
    ["undefined binds", undefined, [], []],
    ["empty binds", [], [], []],
    ["one conflicting bind", [customSkill, otherData], [otherData], [customSkill]],
    ["normalized targets", [skillA, skillB, data], [data], [skillA, skillB]],
    ["no conflicting binds", others, others, []],
    ["all binds conflicting", [skillA, skillB], [], [skillA, skillB]],
    ["no options", [noOptions], [], [noOptions]],
    ["a trailing target slash", [trailingSlash], [], [trailingSlash]],
    ["an unparsed bind retained for validation", ["missing-source"], ["missing-source"], []],
  ] satisfies [string, string[] | undefined, string[], string[]][])(
    "keeps protected mounts authoritative with %s",
    (_name, binds, custom, skipped) => {
      const selection = select(binds);
      expect(selection.custom).toEqual(custom);
      expect(selection.skippedBinds).toEqual(skipped);
      expect(selection.mounts.filter((mount) => mount.source === "protectedSkill")).toEqual([
        {
          hostPath: "/host/skills",
          containerPath: "/workspace/skills",
          readOnly: true,
          source: "protectedSkill",
        },
        {
          hostPath: "/host/.agents/skills",
          containerPath: "/workspace/.agents/skills",
          readOnly: true,
          source: "protectedSkill",
        },
      ]);
    },
  );
});
