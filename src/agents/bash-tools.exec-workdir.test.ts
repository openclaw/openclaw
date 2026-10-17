import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = tempDirs.make("openclaw-exec-workdir-");
});
afterEach(() => vi.restoreAllMocks());

function sandbox(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  return {
    containerName: "sandbox-workdir-test",
    workspaceDir,
    containerWorkdir: "/workspace",
    ...overrides,
  };
}

function backend(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  return sandbox({
    containerWorkdir: "/remote/workspace/",
    workdirValidation: "backend",
    validateWorkdir: async (workdir) => workdir,
    ...overrides,
  });
}

function resolved(
  hostCwd: string,
  containerCwd: string,
  scriptPreflightCwd: string | null = hostCwd,
) {
  return { kind: "sandbox", hostCwd, containerCwd, scriptPreflightCwd };
}

async function expectUnavailable(workdir: string, config: BashSandboxConfig) {
  await expect(resolveExecWorkdir({ host: "sandbox", workdir, sandbox: config })).resolves.toEqual({
    kind: "unavailable",
    requestedCwd: workdir,
  });
}

describe("resolveExecWorkdir", () => {
  it("rejects whitespace-only explicit workdirs", async () => {
    await expect(resolveExecWorkdir({ host: "gateway", workdir: "   " })).resolves.toEqual({
      kind: "unavailable",
      requestedCwd: "   ",
    });
  });

  it("canonicalizes local workdirs before approval and execution", async () => {
    const target = path.join(workspaceDir, "target");
    const link = path.join(workspaceDir, "link");
    await mkdir(target);
    await symlink(target, link, "dir");
    await expect(resolveExecWorkdir({ host: "gateway", workdir: ` ${link} ` })).resolves.toEqual({
      kind: "local",
      hostCwd: target,
    });
  });

  it("fails omitted local workdir when current cwd is unavailable", async () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });
    await expect(resolveExecWorkdir({ host: "gateway" })).resolves.toEqual({
      kind: "unavailable",
      requestedCwd: "current working directory",
    });
  });

  it("rejects missing configured local cwd without falling back to current cwd", async () => {
    const missing = path.join(workspaceDir, "missing");
    vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
    await expect(resolveExecWorkdir({ host: "gateway", defaultCwd: missing })).resolves.toEqual({
      kind: "unavailable",
      requestedCwd: missing,
    });
  });

  it.each([
    { workdir: undefined, nodeCwd: undefined, expected: { kind: "node" } },
    {
      workdir: "/node/explicit",
      nodeCwd: "/node/default",
      expected: { kind: "node", remoteCwd: "/node/explicit" },
    },
  ])(
    "selects remote cwd for $workdir / $nodeCwd without local validation",
    async ({ workdir, nodeCwd, expected }) => {
      await expect(
        resolveExecWorkdir({ host: "node", workdir, nodeCwd, defaultCwd: "/gateway/default" }),
      ).resolves.toEqual(expected);
    },
  );

  it("uses the sandbox workspace when sandbox workdir is omitted", async () => {
    await expect(resolveExecWorkdir({ host: "sandbox", sandbox: sandbox() })).resolves.toEqual(
      resolved(workspaceDir, "/workspace"),
    );
  });

  it("rejects file sandbox workdirs", async () => {
    await writeFile(path.join(workspaceDir, "not-dir"), "not a directory");
    await expect(
      resolveExecWorkdir({ host: "sandbox", defaultCwd: "/workspace/not-dir", sandbox: sandbox() }),
    ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/not-dir" });
  });

  it("rejects sandbox workdirs outside the workspace", async () => {
    await expectUnavailable(tempDirs.make("openclaw-outside-"), sandbox());
  });

  it("rejects sandbox workdirs with parent-directory segments", async () => {
    await expectUnavailable("missing/..", sandbox());
  });

  it.each(["host", "backend"] as const)(
    "rejects workspace symlink escape with %s validation",
    async (validation) => {
      const escape = path.join(workspaceDir, "escape");
      await symlink(tempDirs.make("openclaw-outside-"), escape, "dir");
      await expectUnavailable(
        validation === "backend" ? escape : "escape",
        validation === "backend" ? backend() : sandbox(),
      );
    },
  );

  it("uses the most specific approved mount regardless of input order", async () => {
    const broad = tempDirs.make("openclaw-broad-mount-");
    const skills = tempDirs.make("openclaw-skills-mount-");
    const skillDir = path.join(skills, "demo");
    await mkdir(skillDir);
    await mkdir(path.join(broad, "skills", "demo"), { recursive: true });
    await expect(
      resolveExecWorkdir({
        host: "sandbox",
        workdir: "/workspace/.openclaw/skills/demo",
        sandbox: sandbox({
          readOnlyWorkspaceSkillMounts: [
            { containerPath: "/workspace/.openclaw", hostPath: broad },
            { containerPath: "/workspace/.openclaw/skills", hostPath: skills },
          ],
        }),
      }),
    ).resolves.toEqual(resolved(skillDir, "/workspace/.openclaw/skills/demo"));
  });

  it("does not match sibling paths outside an approved mount prefix", async () => {
    const skills = tempDirs.make("openclaw-skills-mount-");
    await mkdir(path.join(skills, "demo"));
    await expectUnavailable(
      "/workspace/skills-shadow/demo",
      sandbox({
        readOnlyWorkspaceSkillMounts: [{ containerPath: "/workspace/skills", hostPath: skills }],
      }),
    );
  });

  it("rejects symlink escape from an approved mount host root", async () => {
    const skills = tempDirs.make("openclaw-skills-mount-");
    await symlink(tempDirs.make("openclaw-outside-"), path.join(skills, "escape"), "dir");
    await expectUnavailable(
      "/workspace/skills/escape",
      sandbox({
        readOnlyWorkspaceSkillMounts: [{ containerPath: "/workspace/skills", hostPath: skills }],
      }),
    );
  });

  it("lets backend-validated sandboxes use declared alternate remote roots", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    await expect(
      resolveExecWorkdir({
        host: "sandbox",
        workdir: "/agent/project",
        sandbox: backend({ workdirRoots: ["/agent"], validateWorkdir }),
      }),
    ).resolves.toEqual(resolved(workspaceDir, "/agent/project", null));
    expect(validateWorkdir).toHaveBeenCalledWith("/agent/project");
  });

  it("defers stale relative backend workdirs to the backend", async () => {
    await writeFile(path.join(workspaceDir, "build"), "stale local mirror file");
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    await expect(
      resolveExecWorkdir({
        host: "sandbox",
        workdir: "build",
        sandbox: backend({ validateWorkdir }),
      }),
    ).resolves.toEqual(resolved(workspaceDir, "/remote/workspace/build", null));
    expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/build");
  });

  it("accepts backend absolute workdirs when the remote root is slash", async () => {
    await expect(
      resolveExecWorkdir({
        host: "sandbox",
        workdir: "/generated",
        sandbox: backend({ containerWorkdir: "/" }),
      }),
    ).resolves.toEqual(resolved(workspaceDir, "/generated", null));
  });

  it("prefers backend skill mounts over an overlapping host workspace path", async () => {
    const skills = tempDirs.make("openclaw-skills-mount-");
    const containerRoot = path.join(workspaceDir, ".openclaw", "skills");
    const mounted = path.join(skills, "demo");
    await mkdir(mounted);
    await mkdir(path.join(containerRoot, "demo"), { recursive: true });
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    await expect(
      resolveExecWorkdir({
        host: "sandbox",
        workdir: `${containerRoot}/demo`,
        sandbox: backend({
          validateWorkdir,
          readOnlyWorkspaceSkillMounts: [{ containerPath: containerRoot, hostPath: skills }],
        }),
      }),
    ).resolves.toEqual(resolved(mounted, `${containerRoot}/demo`));
    expect(validateWorkdir).toHaveBeenCalledWith(`${containerRoot}/demo`);
  });

  it("rejects backend workdirs outside local and remote roots", async () => {
    await expectUnavailable("/other/remote/workspace", backend());
  });

  it("rejects workdirs when the backend validator fails", async () => {
    await expectUnavailable(
      "/remote/workspace/missing",
      backend({ validateWorkdir: async () => null }),
    );
  });
});
