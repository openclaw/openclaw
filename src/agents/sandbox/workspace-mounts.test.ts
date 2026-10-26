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

function mountParams(workspaceDir: string) {
  return {
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    workdir: "/workspace",
    workspaceAccess: "rw" as const,
  };
}
function workspaceMounts(
  workspaceDir: string,
  overrides: Partial<Parameters<typeof resolveWorkspaceMounts>[0]> = {},
) {
  return resolveWorkspaceMounts({
    ...mountParams(workspaceDir),
    ...overrides,
  }).map((mount) => `${mount.hostPath}:${mount.containerPath}:${mount.readOnly ? "ro,z" : "z"}`);
}

function addSkill(workspaceDir: string, root = "skills") {
  const dir = path.join(workspaceDir, root, "demo");
  fs.mkdirSync(dir, { recursive: true });
}

const dirs = useAutoCleanupTempDirTracker(afterEach);
function makeTempWorkspace(...skillRoots: string[]) {
  const workspace = dirs.make("openclaw-sandbox-mounts-");
  for (const root of skillRoots) {
    addSkill(workspace, root);
  }
  return workspace;
}

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
      await ensureReadOnlyWorkspaceSkillMountSources(mountParams(workspaceDir));
      expect(fs.existsSync(path.join(outsideDir, "skills"))).toBe(false);
      expect(workspaceMounts(workspaceDir)).not.toContain(
        `${path.join(workspaceDir, ".agents", "skills")}:/workspace/.agents/skills:ro,z`,
      );
      if (kind === "file") {
        expect(fs.readFileSync(parent, "utf8")).toBe("existing user file");
      }
    },
  );

  it.each(["rw", "ro", "none"] as const)(
    "sets mount permissions for workspaceAccess=%s",
    (access) => {
      const mounts = workspaceMounts("/tmp/workspace", {
        agentWorkspaceDir: "/tmp/agent-workspace",
        workspaceAccess: access,
      });

      const mode = access === "ro" ? "ro,z" : "z";
      expect(mounts).toEqual([
        `/tmp/workspace:/workspace:${mode}`,
        ...(access === "none" ? [] : [`/tmp/agent-workspace:/agent:${mode}`]),
      ]);
    },
  );

  it.each(["none", "identical"] as const)("omits agent workspace mount for %s", (kind) => {
    const workspaceDir = makeTempWorkspace();
    const mounts = workspaceMounts(workspaceDir, {
      agentWorkspaceDir: kind === "none" ? makeTempWorkspace() : workspaceDir,
      workspaceAccess: kind === "none" ? "none" : "rw",
    });
    expect(mounts).toEqual([`${workspaceDir}:/workspace:z`]);
  });

  it.each(["skills", ".agents/skills", "materialized"])(
    "overlays %s read-only in a writable workspace",
    (source) => {
      const materialized = source === "materialized";
      const root = materialized ? ".openclaw/sandbox-skills/skills" : source;
      const agentWorkspaceDir = makeTempWorkspace(...(materialized ? [] : [root]));
      const skillsWorkspaceDir = materialized ? makeTempWorkspace("skills") : undefined;
      const hostRoot = materialized
        ? path.join(skillsWorkspaceDir!, "skills")
        : path.join(agentWorkspaceDir, root);
      const mounts = workspaceMounts(agentWorkspaceDir, { skillsWorkspaceDir });
      expect(mounts).toEqual([
        `${agentWorkspaceDir}:/workspace:z`,
        `${hostRoot}:/workspace/${root}:ro,z`,
      ]);
      expect(resolveSkillPath(agentWorkspaceDir, "normal.txt").writable).toBe(true);
      for (const filePath of [`${root}/demo/SKILL.md`, `/workspace/${root}/demo/SKILL.md`]) {
        expect(resolveSkillPath(agentWorkspaceDir, filePath, skillsWorkspaceDir)).toMatchObject({
          writable: false,
          hostPath: path.join(hostRoot, "demo/SKILL.md"),
        });
      }
    },
  );

  describe.runIf(process.platform !== "win32")("symlink containment", () => {
    it.each(["skills", ".agents"])("does not overlay through symlinked %s", (root) => {
      const agentWorkspaceDir = makeTempWorkspace();
      const outsideDir = makeTempWorkspace("skills");
      fs.symlinkSync(outsideDir, path.join(agentWorkspaceDir, root), "dir");
      expect(workspaceMounts(agentWorkspaceDir)).toEqual([`${agentWorkspaceDir}:/workspace:z`]);
    });
  });

  it.each(["ro", "none"] as const)(
    "protects %s workspace skills without extra exposure",
    (workspaceAccess) => {
      const agentWorkspaceDir = makeTempWorkspace("skills");
      const sandboxWorkspaceDir = makeTempWorkspace("skills", ".agents/skills");
      const mounts = workspaceMounts(sandboxWorkspaceDir, {
        agentWorkspaceDir,
        workspaceAccess,
      });
      expect(mounts).toEqual([
        `${sandboxWorkspaceDir}:/workspace:${workspaceAccess === "ro" ? "ro,z" : "z"}`,
        ...(workspaceAccess === "ro"
          ? [`${agentWorkspaceDir}:/agent:ro,z`]
          : ["skills", ".agents/skills"].map(
              (root) => `${path.join(sandboxWorkspaceDir, root)}:/workspace/${root}:ro,z`,
            )),
      ]);
    },
  );
});

describe.runIf(process.platform !== "win32")("remote skill mount enforcement", () => {
  it("rejects writes under remote-only skill roots", async () => {
    const remoteWorkspaceDir = makeTempWorkspace("skills");
    const skillsWorkspaceDir = makeTempWorkspace("skills");
    const remote = remoteBridge(makeTempWorkspace(), remoteWorkspaceDir, skillsWorkspaceDir);
    await expectWriteRejected(remote, "skills/demo/SKILL.md");
    await expectWriteRejected(remote, ".openclaw/sandbox-skills/skills/demo/SKILL.md");
  });

  it("rejects mkdirp under skill roots from container cwd", async () => {
    const workspaceDir = makeTempWorkspace("skills");
    const remoteWorkspaceDir = makeTempWorkspace("skills");
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
    const remoteWorkspaceDir = makeTempWorkspace("skills");
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
      ...mountParams(workspaceDir),
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
    expect(selection).toMatchObject({ custom: binds, skippedBinds: [] });
    expect(selection.mounts).toContainEqual({
      hostPath: "/host/custom",
      containerPath: "/workspace/skills",
      readOnly: false,
      source: "bind",
    });
  });

  it.each([
    ["undefined binds", undefined, [], []],
    ["one conflicting bind", [customSkill, otherData], [otherData], [customSkill]],
    ["normalized targets", [skillA, skillB, data], [data], [skillA, skillB]],
    ["no conflicting binds", others, others, []],
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
