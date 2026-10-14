// Workspace mount tests cover Docker bind arguments for workspace access modes
// and read-only skill overlays.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceMounts,
  resolveSandboxMountSelection,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

function mountArgs(mount: ReturnType<typeof resolveWorkspaceMounts>[number]): string[] {
  return ["-v", `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro,z" : "z"}`];
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
    const args = resolveWorkspaceMounts({
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: access,
    }).flatMap(mountArgs);

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const workspaceDir = makeTempWorkspace();
    const agentWorkspaceDir = makeTempWorkspace();
    const args = resolveWorkspaceMounts({
      workspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "none",
    }).flatMap(mountArgs);

    expect(args).toEqual(["-v", `${workspaceDir}:/workspace:z`]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const workspaceDir = makeTempWorkspace();
    const args = resolveWorkspaceMounts({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    }).flatMap(mountArgs);

    const mounts = args.filter((arg) => arg.startsWith(workspaceDir));
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const args = resolveWorkspaceMounts({
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "ro",
    }).flatMap(mountArgs);

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });

  it("overlays workspace skills read-only when workspaceAccess is rw", () => {
    // The writable workspace mount is followed by a narrower read-only skills
    // overlay so sandboxed agents cannot mutate checked-in skill instructions.
    const agentWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(agentWorkspaceDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(agentWorkspaceDir, "skills", "demo", "SKILL.md"), "# Demo\n");

    const args = resolveWorkspaceMounts({
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    }).flatMap(mountArgs);

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
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

    const args = resolveWorkspaceMounts({
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    }).flatMap(mountArgs);

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
  });

  it.runIf(process.platform !== "win32")(
    "does not overlay skill roots through a symlinked parent",
    () => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      fs.mkdirSync(path.join(outsideDir, "skills", "demo"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, ".agents"), "dir");

      const args = resolveWorkspaceMounts({
        workspaceDir: agentWorkspaceDir,
        agentWorkspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      }).flatMap(mountArgs);

      const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
      expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    },
  );

  it("overlays project .agents skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(agentWorkspaceDir, ".agents", "skills", "demo"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(agentWorkspaceDir, ".agents", "skills", "demo", "SKILL.md"),
      "# Demo\n",
    );

    const args = resolveWorkspaceMounts({
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    }).flatMap(mountArgs);

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });

  it("overlays materialized sandbox skills read-only when workspaceAccess is rw", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = makeTempWorkspace();
    const materializedSkillsDir = path.join(skillsWorkspaceDir, "skills");
    fs.mkdirSync(path.join(materializedSkillsDir, "demo"), { recursive: true });
    fs.writeFileSync(path.join(materializedSkillsDir, "demo", "SKILL.md"), "# Demo\n");

    const args = resolveWorkspaceMounts({
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    }).flatMap(mountArgs);

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(skillsWorkspaceDir),
    );
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${materializedSkillsDir}:/workspace/.openclaw/sandbox-skills/skills:ro,z`,
    ]);
  });

  it("does not add a separate synced skill overlay when workspaceAccess is ro", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });

    const args = resolveWorkspaceMounts({
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "ro",
    }).flatMap(mountArgs);

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(sandboxWorkspaceDir),
    );

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

    const args = resolveWorkspaceMounts({
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "none",
    }).flatMap(mountArgs);

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(sandboxWorkspaceDir),
    );

    expect(mounts).toEqual([
      `${sandboxWorkspaceDir}:/workspace:z`,
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
      `${path.join(sandboxWorkspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
    ]);
  });
});

describe("resolveSandboxMountSelection", () => {
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
    const binds = ["/host/custom:/workspace/skills:rw"];
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
    { name: "undefined binds", binds: undefined, custom: [], skipped: [] },
    { name: "empty binds", binds: [], custom: [], skipped: [] },
    {
      name: "one conflicting bind",
      binds: ["/host/custom:/workspace/skills:rw", "/host/other:/data:rw"],
      custom: ["/host/other:/data:rw"],
      skipped: ["/host/custom:/workspace/skills:rw"],
    },
    {
      name: "multiple conflicting binds and normalized resource targets",
      binds: [
        "/host/a:/workspace/skills:ro",
        "/host/b:/workspace/.agents/skills:ro",
        "/host/c:/data:rw",
      ],
      custom: ["/host/c:/data:rw"],
      skipped: ["/host/a:/workspace/skills:ro", "/host/b:/workspace/.agents/skills:ro"],
    },
    {
      name: "no conflicting binds",
      binds: ["/host/a:/data:rw", "/host/b:/tmp:ro"],
      custom: ["/host/a:/data:rw", "/host/b:/tmp:ro"],
      skipped: [],
    },
    {
      name: "all binds conflicting",
      binds: ["/host/a:/workspace/skills:ro", "/host/b:/workspace/.agents/skills:ro"],
      custom: [],
      skipped: ["/host/a:/workspace/skills:ro", "/host/b:/workspace/.agents/skills:ro"],
    },
    {
      name: "a conflicting bind without options",
      binds: ["/host/custom:/workspace/skills"],
      custom: [],
      skipped: ["/host/custom:/workspace/skills"],
    },
    {
      name: "a conflicting bind with a trailing target slash",
      binds: ["/host/custom:/workspace/skills/"],
      custom: [],
      skipped: ["/host/custom:/workspace/skills/"],
    },
    {
      name: "an unparsed bind retained for validation",
      binds: ["missing-source"],
      custom: ["missing-source"],
      skipped: [],
    },
  ])("keeps protected mounts authoritative with $name", ({ binds, custom, skipped }) => {
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
  });
});
