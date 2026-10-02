import fs from "node:fs/promises";
import path from "node:path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellMirrorBackend } from "./backend.types.js";
import { createOpenShellFsBridge } from "./fs-bridge.js";
import { createOpenShellTestWorkspace, expectPathMissing } from "./openshell-fs.test-support.js";

function createBackend() {
  return {
    remoteAgentWorkspaceDir: "/agent",
    mkdirpRemotePath: vi
      .fn<OpenShellMirrorBackend["mkdirpRemotePath"]>()
      .mockResolvedValue(undefined),
    renameRemotePath: vi
      .fn<OpenShellMirrorBackend["renameRemotePath"]>()
      .mockResolvedValue(undefined),
    removeRemotePath: vi
      .fn<OpenShellMirrorBackend["removeRemotePath"]>()
      .mockResolvedValue(undefined),
    syncLocalPathToRemote: vi
      .fn<OpenShellMirrorBackend["syncLocalPathToRemote"]>()
      .mockResolvedValue(undefined),
  } satisfies OpenShellMirrorBackend;
}

describe("openshell mirror fs bridges", () => {
  let workspaceDir: string;
  let backend: ReturnType<typeof createBackend>;
  let bridge: ReturnType<typeof createOpenShellFsBridge>;

  function createBridge(overrides: Partial<ReturnType<typeof createSandboxTestContext>> = {}) {
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "openshell",
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        containerWorkdir: "/sandbox",
        ...overrides,
      },
    });
    return createOpenShellFsBridge({ sandbox, backend });
  }

  async function swapParentAfterRemote(
    method: "mkdirpRemotePath" | "removeRemotePath" | "renameRemotePath",
    outsideDir: string,
  ) {
    const slotPath = path.join(workspaceDir, "slot");
    await fs.mkdir(slotPath, { recursive: true });
    backend[method].mockImplementation(async () => {
      await fs.rm(slotPath, { recursive: true, force: true });
      await fs.symlink(outsideDir, slotPath);
    });
    return slotPath;
  }

  beforeEach(async () => {
    const workspace = await createOpenShellTestWorkspace("fs");
    workspaceDir = workspace.dir;
    backend = createBackend();
    bridge = createBridge();
    return () => workspace[Symbol.asyncDispose]();
  });

  it.each([
    { workspaceAccess: "none", mutation: "write" },
    { workspaceAccess: "ro", mutation: "write" },
    { workspaceAccess: "rw", mutation: "remove" },
    { workspaceAccess: "rw", mutation: "rename" },
  ] as const)(
    "enforces $workspaceAccess workspace writes and protects skills from $mutation",
    async ({ workspaceAccess, mutation }) => {
      bridge = createBridge({ workspaceAccess });
      if (workspaceAccess === "ro") {
        await expect(bridge.writeFile({ filePath: "file.txt", data: "blocked" })).rejects.toThrow(
          "read-only",
        );
        expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
        return;
      }
      await bridge.writeFile({
        filePath: "nested/file.txt",
        data: "hello",
        mkdir: true,
      });

      expect(await fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).toBe(
        "hello",
      );
      expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
        path.join(workspaceDir, "nested", "file.txt"),
        "/sandbox/nested/file.txt",
      );
      const skillRelativePath =
        mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
      const skillPath = path.join(workspaceDir, skillRelativePath);
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "managed instructions");
      const mutate =
        mutation === "write"
          ? bridge.writeFile({ filePath: skillRelativePath, data: "changed" })
          : mutation === "remove"
            ? bridge.remove({ filePath: ".agents", recursive: true })
            : bridge.rename({ from: ".agents", to: "moved-instructions" });
      await expect(mutate).rejects.toThrow("read-only");
      await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("managed instructions");
    },
  );

  it("creates mirror files exclusively before syncing them", async () => {
    await expect(
      bridge.createFileExclusive({ filePath: "nested/file.txt", data: "first" }),
    ).resolves.toBe("created");
    await expect(
      bridge.createFileExclusive({ filePath: "nested/file.txt", data: "replacement" }),
    ).resolves.toBe("exists");
    await expect(fs.readFile(path.join(workspaceDir, "nested", "file.txt"), "utf8")).resolves.toBe(
      "first",
    );
    expect(backend.syncLocalPathToRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps the canonical local exclusive create when mirror sync fails", async () => {
    backend.syncLocalPathToRemote.mockRejectedValue(new Error("remote rejected"));
    await expect(
      bridge.createFileExclusive({ filePath: "file.txt", data: "canonical" }),
    ).rejects.toThrow("remote rejected");
    await expect(fs.readFile(path.join(workspaceDir, "file.txt"), "utf8")).resolves.toBe(
      "canonical",
    );
  });

  it("rejects cross-root mirror renames before the remote backend commit", async () => {
    await using agentWorkspace = await createOpenShellTestWorkspace("agent-fs");
    const agentWorkspaceDir = agentWorkspace.dir;
    const sourcePath = path.join(workspaceDir, "source.txt");
    await fs.writeFile(sourcePath, "payload", "utf8");
    bridge = createBridge({ agentWorkspaceDir });

    await expect(bridge.rename({ from: "source.txt", to: "/agent/source.txt" })).rejects.toThrow(
      "OpenShell cross-root mirror renames require pinned fs-safe support",
    );
    expect(backend.renameRemotePath).not.toHaveBeenCalled();
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
    await expectPathMissing(path.join(agentWorkspaceDir, "source.txt"));
    await expect(fs.readdir(agentWorkspaceDir)).resolves.toStrictEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects local mirror symlink rename sources before the remote backend commit",
    async () => {
      await fs.writeFile(path.join(workspaceDir, "target.txt"), "payload", "utf8");
      await fs.symlink("target.txt", path.join(workspaceDir, "link.txt"));

      await expect(bridge.rename({ from: "link.txt", to: "moved-link.txt" })).rejects.toThrow(
        "Sandbox symlink rename sources are not supported",
      );
      expect(backend.renameRemotePath).not.toHaveBeenCalled();
      await expect(fs.readlink(path.join(workspaceDir, "link.txt"))).resolves.toBe("target.txt");
      await expectPathMissing(path.join(workspaceDir, "moved-link.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror hardlinked rename sources before the remote backend commit",
    async () => {
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.writeFile(sourcePath, "payload", "utf8");
      await fs.link(sourcePath, path.join(workspaceDir, "other-link.txt"));

      await expect(bridge.rename({ from: "source.txt", to: "moved.txt" })).rejects.toThrow(
        "Sandbox hardlinked rename sources are not supported",
      );
      expect(backend.renameRemotePath).not.toHaveBeenCalled();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(workspaceDir, "moved.txt"));
    },
  );

  it("removes deep local mirror trees while retaining the mounted root", async () => {
    const rootIdentity = await fs.stat(workspaceDir, { bigint: true });
    const deepestDir = path.join(workspaceDir, "nested", ...Array<string>(65).fill("d"));
    await fs.mkdir(deepestDir, { recursive: true });
    await fs.writeFile(path.join(deepestDir, "target.txt"), "payload", "utf8");
    await bridge.remove({ filePath: ".", recursive: true, force: true });

    await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
    await expect(fs.stat(workspaceDir, { bigint: true })).resolves.toMatchObject({
      dev: rootIdentity.dev,
      ino: rootIdentity.ino,
    });
    expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox", {
      recursive: true,
      signal: undefined,
      ignoreMissing: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "removes recursive local mirror directories containing symlink leaves without following them",
    async () => {
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "nested", "link.txt"));
      await fs.symlink(outsideDir, path.join(workspaceDir, "nested", "directory-link"));
      await fs.symlink("missing", path.join(workspaceDir, "nested", "dangling-link"));
      await bridge.remove({ filePath: "nested", recursive: true, force: true });

      await expectPathMissing(path.join(workspaceDir, "nested"));
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32").each([false, true])(
    "removes local mirror symlink leaves when force is false and recursive is %s",
    async (recursive) => {
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(outsideTarget, "outside", "utf8");
      await fs.symlink(outsideTarget, path.join(workspaceDir, "link.txt"));
      await bridge.remove({ filePath: "link.txt", force: false, recursive });

      await expectPathMissing(path.join(workspaceDir, "link.txt"));
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
      expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/link.txt", {
        recursive,
        signal: undefined,
        ignoreMissing: false,
      });
    },
  );

  it.each([false, true])(
    "preserves missing local mirror path handling when recursive is %s",
    async (recursive) => {
      await expect(
        bridge.remove({ filePath: "missing", recursive, force: false }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(bridge.remove({ filePath: "missing", recursive })).resolves.toBeUndefined();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror mkdir when a validated parent is swapped to an outside symlink",
    async () => {
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      await swapParentAfterRemote("mkdirpRemotePath", outsideDir);

      await expect(bridge.mkdirp({ filePath: "slot/escaped" })).rejects.toThrow();
      await expectPathMissing(path.join(outsideDir, "escaped"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror remove when a validated parent is swapped to an outside symlink",
    async () => {
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      const slotPath = await swapParentAfterRemote("removeRemotePath", outsideDir);
      const outsideTarget = path.join(outsideDir, "target.txt");
      await fs.writeFile(path.join(slotPath, "target.txt"), "inside", "utf8");
      await fs.writeFile(outsideTarget, "outside", "utf8");

      await expect(bridge.remove({ filePath: "slot/target.txt", force: true })).rejects.toThrow();
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects local mirror rename when a validated destination parent is swapped to an outside symlink",
    async () => {
      await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
      const outsideDir = outsideWorkspace.dir;
      await swapParentAfterRemote("renameRemotePath", outsideDir);
      const sourcePath = path.join(workspaceDir, "source.txt");
      await fs.writeFile(sourcePath, "payload", "utf8");

      await expect(
        bridge.rename({ from: "source.txt", to: "slot/parent/moved.txt" }),
      ).rejects.toThrow();
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      await expectPathMissing(path.join(outsideDir, "parent", "moved.txt"));
    },
  );

  it.each(["mkdirpRemotePath", "removeRemotePath", "renameRemotePath"] as const)(
    "keeps local state unchanged when %s is rejected",
    async (operation) => {
      const sourcePath = path.join(workspaceDir, "source.txt");
      if (operation !== "mkdirpRemotePath") {
        await fs.writeFile(sourcePath, "payload", "utf8");
      }
      backend[operation].mockRejectedValue(new Error("remote rejected"));
      const mutation =
        operation === "mkdirpRemotePath"
          ? bridge.mkdirp({ filePath: "nested/target.txt" })
          : operation === "removeRemotePath"
            ? bridge.remove({ filePath: "source.txt", force: true })
            : bridge.rename({ from: "source.txt", to: "nested/target.txt" });
      await expect(mutation).rejects.toThrow("remote rejected");
      if (operation !== "mkdirpRemotePath") {
        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("payload");
      }
      if (operation !== "removeRemotePath") {
        await expectPathMissing(
          path.join(
            workspaceDir,
            operation === "mkdirpRemotePath" ? "nested" : "nested/target.txt",
          ),
        );
      }
    },
  );

  it("rejects symlink-parent writes instead of escaping the local mount root", async () => {
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.symlink(outsideDir, path.join(workspaceDir, "alias"));

    await expect(
      bridge.writeFile({ filePath: "alias/escape.txt", data: "owned", mkdir: true }),
    ).rejects.toThrow();
    await expectPathMissing(path.join(outsideDir, "escape.txt"));
    await expect(fs.readdir(outsideDir)).resolves.toStrictEqual([]);
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
  });

  it("rejects writes and creates whose final target is a symlink inside the local mount root", async () => {
    const linkedTarget = path.join(workspaceDir, "existing.txt");
    await fs.writeFile(linkedTarget, "keep", "utf8");
    await fs.symlink("existing.txt", path.join(workspaceDir, "link.txt"));

    await expect(
      bridge.writeFile({ filePath: "link.txt", data: "owned", mkdir: true }),
    ).rejects.toThrow();
    await expect(
      bridge.createFileExclusive({ filePath: "link.txt", data: "owned" }),
    ).rejects.toThrow();
    await expect(fs.readlink(path.join(workspaceDir, "link.txt"))).resolves.toBe("existing.txt");
    await expect(fs.readFile(linkedTarget, "utf8")).resolves.toBe("keep");
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
  });

  it("rejects a parent symlink that lands outside the sandbox root", async () => {
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const outsideDir = outsideWorkspace.dir;
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8");
    await fs.symlink(outsideDir, path.join(workspaceDir, "subdir"));

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
    await expect(bridge.readDirectory({ filePath: "subdir" })).rejects.toThrow();
  });

  it("reads regular files and directories through the shared safe fs root", async () => {
    await fs.mkdir(path.join(workspaceDir, "subdir", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "subdir", "secret.txt"), "inside", "utf8");

    await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([
      { name: "subdir", isDirectory: true },
    ]);
    await expect(bridge.readDirectory({ filePath: ".", cwd: "/sandbox/subdir" })).resolves.toEqual([
      { name: "nested", isDirectory: true },
      { name: "secret.txt", isDirectory: false },
    ]);
    await expect(bridge.readFile({ filePath: "subdir/secret.txt", maxBytes: 6 })).resolves.toEqual(
      Buffer.from("inside"),
    );
    await expect(bridge.readFile({ filePath: "subdir/secret.txt", maxBytes: 5 })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
    await fs.symlink(
      path.join(workspaceDir, "subdir"),
      path.join(workspaceDir, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(bridge.readDirectory({ filePath: "alias" })).rejects.toThrow();
  });

  it("keeps literal tilde directories inside the mirror workspace", async () => {
    const filePath = path.join(workspaceDir, "~", "file.txt");
    await fs.mkdir(path.dirname(filePath));
    await fs.writeFile(filePath, "literal");

    await expect(bridge.readFile({ filePath: "./~/file.txt" })).resolves.toEqual(
      Buffer.from("literal"),
    );
    await expect(bridge.readDirectory({ filePath: "./~" })).resolves.toEqual([
      { name: "file.txt", isDirectory: false },
    ]);
    await bridge.writeFile({ filePath: "./~/file.txt", data: "updated" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("updated");
    await expect(
      bridge.createFileExclusive({ filePath: "./~/created.txt", data: "created" }),
    ).resolves.toBe("created");
    await bridge.mkdirp({ filePath: "./~/nested" });
    expect((await fs.stat(path.join(workspaceDir, "~", "nested"))).isDirectory()).toBe(true);
    expect(backend.mkdirpRemotePath).toHaveBeenCalledWith("/sandbox/~/nested", undefined);
    await bridge.rename({ from: "./~/created.txt", to: "./~/nested/target/moved.txt" });
    expect(backend.renameRemotePath).toHaveBeenCalledWith(
      "/sandbox/~/created.txt",
      "/sandbox/~/nested/target/moved.txt",
      undefined,
    );
    await expect(
      fs.readFile(path.join(workspaceDir, "~", "nested", "target", "moved.txt"), "utf8"),
    ).resolves.toBe("created");
    await bridge.remove({ filePath: "./~/file.txt", force: false });
    expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/~/file.txt", {
      recursive: false,
      signal: undefined,
      ignoreMissing: false,
    });
    await expectPathMissing(filePath);
    await bridge.remove({ filePath: ".", recursive: true });
    await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
  });

  it.each(["external", "nested"] as const)(
    "reads materialized sandbox skills from a protected %s skills workspace",
    async (location) => {
      await using skillsWorkspace = await createOpenShellTestWorkspace("skills");
      const skillsWorkspaceDir =
        location === "external" ? skillsWorkspace.dir : path.join(workspaceDir, "materialized");
      const skillFile = path.join(skillsWorkspaceDir, "skills", "demo", "SKILL.md");
      const virtualSkillPath = ".openclaw/sandbox-skills/skills/demo/SKILL.md";
      const shadowFile = path.join(workspaceDir, virtualSkillPath);
      await fs.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.mkdir(path.dirname(shadowFile), { recursive: true });
      await fs.writeFile(skillFile, "# Demo\nmaterialized\n", "utf8");
      await fs.writeFile(path.join(path.dirname(skillFile), "examples.md"), "examples", "utf8");
      await fs.writeFile(shadowFile, "# Demo\nworkspace shadow\n", "utf8");

      bridge = createBridge({ skillsWorkspaceDir });

      await expect(
        bridge.readDirectory({ filePath: "/sandbox/.openclaw/sandbox-skills/skills/demo" }),
      ).resolves.toEqual([
        { name: "SKILL.md", isDirectory: false },
        { name: "examples.md", isDirectory: false },
      ]);
      await expect(bridge.readFile({ filePath: `/sandbox/${virtualSkillPath}` })).resolves.toEqual(
        Buffer.from("# Demo\nmaterialized\n"),
      );
      await expect(bridge.readFile({ filePath: virtualSkillPath })).resolves.toEqual(
        Buffer.from("# Demo\nmaterialized\n"),
      );
      await expect(bridge.writeFile({ filePath: virtualSkillPath, data: "owned" })).rejects.toThrow(
        /read-only/,
      );
      await expect(bridge.writeFile({ filePath: shadowFile, data: "owned" })).rejects.toThrow(
        /read-only/,
      );
      await expect(bridge.writeFile({ filePath: skillFile, data: "owned" })).rejects.toThrow(
        /read-only/,
      );
      await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("materialized");
      expect(await fs.readFile(shadowFile, "utf8")).toContain("workspace shadow");
      expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
    },
  );

  it.each(["symlink", "link"] as const)("rejects reads through a %s leaf", async (link) => {
    await using outsideWorkspace = await createOpenShellTestWorkspace("outside");
    const source = path.join(outsideWorkspace.dir, "secret.txt");
    await fs.mkdir(path.join(workspaceDir, "subdir"));
    await fs.writeFile(source, "outside", "utf8");
    await fs[link](source, path.join(workspaceDir, "subdir", "secret.txt"));

    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    await using agentWorkspace = await createOpenShellTestWorkspace("agent");
    const agentWorkspaceDir = agentWorkspace.dir;
    await fs.writeFile(path.join(agentWorkspaceDir, "note.txt"), "agent", "utf8");
    backend.remoteAgentWorkspaceDir = "/native-agent-root";
    bridge = createBridge({ agentWorkspaceDir, workspaceAccess: "ro" });
    expect(bridge.pathMappings).toContainEqual({
      hostRoot: path.resolve(agentWorkspaceDir),
      containerRoot: "/native-agent-root",
    });
    const resolved = bridge.resolvePath({ filePath: "/native-agent-root/note.txt" });
    expect(resolved.hostPath).toBe(path.join(agentWorkspaceDir, "note.txt"));
    expect(await bridge.readFile({ filePath: "/native-agent-root/note.txt" })).toEqual(
      Buffer.from("agent"),
    );
    await expect(bridge.readDirectory({ filePath: "/native-agent-root" })).resolves.toEqual([
      { name: "note.txt", isDirectory: false },
    ]);
  });

  it.each([
    {
      name: "nested primary root",
      workspaceRemote: "/sandbox/agent/project",
      agentRemote: "/sandbox/agent",
      target: "/sandbox/agent/project/note.txt",
      owner: "workspace",
    },
    {
      name: "relative path under a nested agent root",
      workspaceRemote: "/sandbox",
      agentRemote: "/sandbox/nested/agent",
      target: "nested/agent/note.txt",
      owner: "agent",
    },
    {
      name: "relative path under equal roots",
      workspaceRemote: "/sandbox",
      agentRemote: "/sandbox",
      target: "note.txt",
      owner: "workspace",
    },
  ])("routes $name to the authoritative host workspace", async (scenario) => {
    await using agentWorkspace = await createOpenShellTestWorkspace("agent");
    backend.remoteAgentWorkspaceDir = scenario.agentRemote;
    bridge = createBridge({
      agentWorkspaceDir: agentWorkspace.dir,
      workspaceAccess: "ro",
      containerWorkdir: scenario.workspaceRemote,
    });
    const resolved = bridge.resolvePath({ filePath: scenario.target });
    expect(resolved.hostPath).toBe(
      path.join(scenario.owner === "agent" ? agentWorkspace.dir : workspaceDir, "note.txt"),
    );
  });
});
