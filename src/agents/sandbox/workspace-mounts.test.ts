// Workspace mount tests cover Docker bind arguments for workspace access modes
// and read-only skill overlays.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWorkspaceMountArgs,
  ensureReadOnlyWorkspaceSkillMountSources,
  resolveReadOnlyWorkspaceSkillMounts,
} from "./workspace-mounts.js";

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

describe("appendWorkspaceMountArgs", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace:z" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro,z" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:ro,z" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: access,
    });

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z"]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const workspaceDir = makeTempWorkspace();
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(workspaceDir));
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/agent-workspace",
      workdir: "/workspace",
      workspaceAccess: "ro",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });

  it("overlays workspace skills read-only when workspaceAccess is rw", () => {
    // The writable workspace mount is followed by a narrower read-only skills
    // overlay so sandboxed agents cannot mutate checked-in skill instructions.
    const agentWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(agentWorkspaceDir, "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(agentWorkspaceDir, "skills", "demo", "SKILL.md"), "# Demo\n");

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    ]);
  });

  it("materializes missing protected skill roots before first rw sandbox launch", async () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = path.join(makeTempWorkspace(), ".openclaw", "sandbox-skills");

    await ensureReadOnlyWorkspaceSkillMountSources({
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

    expect(fs.statSync(path.join(agentWorkspaceDir, "skills")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(agentWorkspaceDir, ".agents", "skills")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(skillsWorkspaceDir, "skills")).isDirectory()).toBe(true);

    expect(
      resolveReadOnlyWorkspaceSkillMounts({
        workspaceDir: agentWorkspaceDir,
        agentWorkspaceDir,
        skillsWorkspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      }),
    ).toEqual([
      {
        hostPath: path.join(agentWorkspaceDir, "skills"),
        containerPath: "/workspace/skills",
      },
      {
        hostPath: path.join(agentWorkspaceDir, ".agents", "skills"),
        containerPath: "/workspace/.agents/skills",
      },
      {
        hostPath: path.join(skillsWorkspaceDir, "skills"),
        containerPath: "/workspace/.openclaw/sandbox-skills/skills",
      },
    ]);
  });

  it.runIf(process.platform !== "win32")("does not overlay symlinked workspace skill roots", () => {
    // Skill overlays must be real workspace directories; symlinks could expose
    // arbitrary host paths read-only inside the sandbox.
    const agentWorkspaceDir = makeTempWorkspace();
    const outsideDir = makeTempWorkspace();
    fs.mkdirSync(path.join(outsideDir, "demo"), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, "skills"), "dir");

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

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

      const args: string[] = [];
      appendWorkspaceMountArgs({
        args,
        workspaceDir: agentWorkspaceDir,
        agentWorkspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      });

      const mounts = args.filter((arg) => arg.startsWith(agentWorkspaceDir));
      expect(mounts).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not materialize missing skill roots through a symlinked parent",
    async () => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      const skillsWorkspaceDir = path.join(makeTempWorkspace(), ".openclaw", "sandbox-skills");
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, ".agents"), "dir");

      await ensureReadOnlyWorkspaceSkillMountSources({
        workspaceDir: agentWorkspaceDir,
        agentWorkspaceDir,
        skillsWorkspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      });

      expect(fs.existsSync(path.join(outsideDir, "skills"))).toBe(false);
      expect(
        resolveReadOnlyWorkspaceSkillMounts({
          workspaceDir: agentWorkspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir,
          workdir: "/workspace",
          workspaceAccess: "rw",
        }),
      ).toEqual([
        {
          hostPath: path.join(agentWorkspaceDir, "skills"),
          containerPath: "/workspace/skills",
        },
        {
          hostPath: path.join(skillsWorkspaceDir, "skills"),
          containerPath: "/workspace/.openclaw/sandbox-skills/skills",
        },
      ]);
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

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

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

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: agentWorkspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "rw",
    });

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

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "ro",
    });

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

  it("does not add a separate synced skill overlay when workspaceAccess is none", () => {
    const agentWorkspaceDir = makeTempWorkspace();
    const sandboxWorkspaceDir = makeTempWorkspace();
    fs.mkdirSync(path.join(sandboxWorkspaceDir, "skills", "demo"), { recursive: true });

    const args: string[] = [];
    appendWorkspaceMountArgs({
      args,
      workspaceDir: sandboxWorkspaceDir,
      agentWorkspaceDir,
      workdir: "/workspace",
      workspaceAccess: "none",
    });

    const mounts = args.filter(
      (arg) => arg.startsWith(agentWorkspaceDir) || arg.startsWith(sandboxWorkspaceDir),
    );

    expect(mounts).toEqual([`${sandboxWorkspaceDir}:/workspace:ro,z`]);
    expect(mounts).not.toContain(
      `${path.join(sandboxWorkspaceDir, "skills")}:/workspace/skills:ro,z`,
    );
  });
});
