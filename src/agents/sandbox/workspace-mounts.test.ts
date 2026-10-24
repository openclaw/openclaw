import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";
import {
  ensureReadOnlyWorkspaceSkillMountSources,
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
}

const dirs = useAutoCleanupTempDirTracker(afterEach);
const makeTempWorkspace = () => dirs.make("openclaw-sandbox-mounts-");

function resolveSkillPath(workspaceDir: string, filePath: string, skillsWorkspaceDir?: string) {
  const sandbox = createSandbox({
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    skillsWorkspaceDir,
  });
  return resolveSandboxFsPathWithMounts({
    filePath,
    cwd: workspaceDir,
    defaultWorkspaceRoot: workspaceDir,
    defaultContainerRoot: sandbox.containerWorkdir,
    mounts: buildSandboxFsMounts(sandbox),
  });
}

const runRemoteShellScript = createLocalRemoteShellScriptRunner({ shellArg0: "openclaw-test" });
function remoteBridge(
  workspaceDir: string,
  remoteWorkspaceDir = workspaceDir,
  skillsWorkspaceDir?: string,
) {
  const localRoot = fs.realpathSync(workspaceDir);
  const remoteRoot = fs.realpathSync(remoteWorkspaceDir);
  return {
    remoteRoot,
    bridge: createRemoteShellSandboxFsBridge({
      sandbox: createSandbox({
        workspaceDir: localRoot,
        agentWorkspaceDir: localRoot,
        skillsWorkspaceDir: skillsWorkspaceDir && fs.realpathSync(skillsWorkspaceDir),
      }),
      runtime: {
        remoteWorkspaceDir: remoteRoot,
        remoteAgentWorkspaceDir: remoteRoot,
        runRemoteShellScript,
      },
    }),
  };
}

async function expectWriteRejected(
  { bridge, remoteRoot }: ReturnType<typeof remoteBridge>,
  filePath: string,
  targetPath = filePath,
) {
  await expect(bridge.writeFile({ filePath, cwd: remoteRoot, data: "# Demo\n" })).rejects.toThrow(
    /read-only/,
  );
  await expect(fs.promises.stat(path.join(remoteRoot, targetPath))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

describe("resolveWorkspaceMounts", () => {
  it.skipIf(process.platform === "win32").each(["symlink", "file"] as const)(
    "does not materialize skill sources through a %s parent",
    async (kind) => {
      const workspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      const parent = path.join(workspaceDir, ".agents");
      if (kind === "symlink") {
        fs.symlinkSync(outsideDir, parent, "dir");
      } else {
        fs.writeFileSync(parent, "existing user file");
      }
      await ensureReadOnlyWorkspaceSkillMountSources({
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workdir: "/workspace",
        workspaceAccess: "rw",
      });
      expect(fs.existsSync(path.join(outsideDir, "skills"))).toBe(false);
      expect(workspaceMounts(workspaceDir)).not.toContain(
        `${path.join(workspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
      );
      if (kind === "file") {
        expect(fs.readFileSync(parent, "utf8")).toBe("existing user file");
      }
    },
  );

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

  it.each(["none", "identical"] as const)("omits agent workspace mount for %s", (kind) => {
    const workspaceDir = makeTempWorkspace();
    const mounts = workspaceMounts(workspaceDir, {
      agentWorkspaceDir: kind === "none" ? makeTempWorkspace() : workspaceDir,
      workspaceAccess: kind === "none" ? "none" : "rw",
    });
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const mounts = workspaceMounts("/tmp/workspace", {
      agentWorkspaceDir: "/tmp/agent-workspace",
      workspaceAccess: "ro",
    });

    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });

  it.each(["skills", ".agents/skills"])("overlays %s read-only in a writable workspace", (root) => {
    const agentWorkspaceDir = makeTempWorkspace();
    addSkill(agentWorkspaceDir, root);
    const mounts = workspaceMounts(agentWorkspaceDir);
    expect(mounts).toEqual([
      `${agentWorkspaceDir}:/workspace:z`,
      `${path.join(agentWorkspaceDir, root)}:/workspace/${root}:ro,z`,
    ]);
    expect(resolveSkillPath(agentWorkspaceDir, "normal.txt").writable).toBe(true);
    for (const filePath of [`${root}/demo/SKILL.md`, `/workspace/${root}/demo/SKILL.md`]) {
      expect(resolveSkillPath(agentWorkspaceDir, filePath).writable).toBe(false);
    }
  });

  describe.runIf(process.platform !== "win32")("symlink containment", () => {
    it.each(["skills", ".agents"])("does not overlay through symlinked %s", (root) => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace();
      fs.mkdirSync(path.join(outsideDir, "skills", "demo"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, root), "dir");
      expect(workspaceMounts(agentWorkspaceDir)).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    });
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
    for (const prefix of ["", "/workspace/"]) {
      expect(
        resolveSkillPath(
          agentWorkspaceDir,
          `${prefix}.openclaw/sandbox-skills/skills/demo/SKILL.md`,
          skillsWorkspaceDir,
        ),
      ).toMatchObject({
        writable: false,
        hostPath: path.join(materializedSkillsDir, "demo/SKILL.md"),
      });
    }
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

describe.runIf(process.platform !== "win32")("remote skill mount enforcement", () => {
  it("rejects writes under remote-only skill roots", async () => {
    const remoteWorkspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = makeTempWorkspace();
    addSkill(remoteWorkspaceDir);
    addSkill(skillsWorkspaceDir);
    const remote = remoteBridge(makeTempWorkspace(), remoteWorkspaceDir, skillsWorkspaceDir);
    await expectWriteRejected(remote, "skills/demo/SKILL.md");
    await expectWriteRejected(remote, ".openclaw/sandbox-skills/skills/demo/SKILL.md");
  });

  it("rejects materialized skill writes with a separate remote workspace", async () => {
    const workspaceDir = makeTempWorkspace();
    const skillsWorkspaceDir = makeTempWorkspace();
    addSkill(skillsWorkspaceDir);
    await expectWriteRejected(
      remoteBridge(workspaceDir, makeTempWorkspace(), skillsWorkspaceDir),
      ".openclaw/sandbox-skills/skills/demo/SKILL.md",
    );
  });

  it("rejects mkdirp under skill roots from container cwd", async () => {
    const workspaceDir = makeTempWorkspace();
    const remoteWorkspaceDir = makeTempWorkspace();
    addSkill(workspaceDir);
    addSkill(remoteWorkspaceDir);
    const { bridge, remoteRoot } = remoteBridge(workspaceDir, remoteWorkspaceDir);
    const filePath = "skills/demo/generated";
    await expect(bridge.mkdirp({ filePath, cwd: remoteRoot })).rejects.toThrow(/read-only/);
    await expect(fs.promises.stat(path.join(remoteRoot, filePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

// Canonical path checks execute the real GNU readlink/stat scripts.
describe.runIf(process.platform === "linux")("remote skill canonical paths", () => {
  it("allows writes under absent skill roots", async () => {
    const { bridge, remoteRoot } = remoteBridge(makeTempWorkspace());
    await bridge.writeFile({ filePath: "skills/new.txt", data: "created" });
    expect(await fs.promises.readFile(path.join(remoteRoot, "skills/new.txt"), "utf8")).toBe(
      "created",
    );
  });

  it("rejects writes through symlinks into skill roots", async () => {
    const remoteWorkspaceDir = makeTempWorkspace();
    addSkill(remoteWorkspaceDir);
    fs.symlinkSync("skills", path.join(remoteWorkspaceDir, "link"), "dir");
    await expectWriteRejected(
      remoteBridge(makeTempWorkspace(), remoteWorkspaceDir),
      "link/demo/SKILL.md",
      "skills/demo/SKILL.md",
    );
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
      expect({ custom: selection.custom, skipped: selection.skippedBinds }).toEqual({
        custom,
        skipped,
      });
      expect(selection.mounts.filter((mount) => mount.source === "protectedSkill")).toEqual(
        [
          ["/host/skills", "/workspace/skills"],
          ["/host/.agents/skills", "/workspace/.agents/skills"],
        ].map(([hostPath, containerPath]) => ({
          hostPath,
          containerPath,
          readOnly: true,
          source: "protectedSkill",
        })),
      );
    },
  );
});
