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
  const local = (filePath: string) => path.join(workspaceDir, filePath);
  const readLocal = (filePath: string) => fs.readFile(local(filePath), "utf8");
  async function seedLocal(filePath: string, data = "payload") {
    await fs.mkdir(path.dirname(local(filePath)), { recursive: true });
    await fs.writeFile(local(filePath), data);
  }
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
      await bridge.writeFile({ filePath: "nested/file.txt", data: "hello", mkdir: true });
      expect(await readLocal("nested/file.txt")).toBe("hello");
      expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
        local("nested/file.txt"),
        "/sandbox/nested/file.txt",
      );
      const skill = mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
      await seedLocal(skill, "managed instructions");
      const mutate =
        mutation === "write"
          ? bridge.writeFile({ filePath: skill, data: "changed" })
          : mutation === "remove"
            ? bridge.remove({ filePath: ".agents", recursive: true })
            : bridge.rename({ from: ".agents", to: "moved-instructions" });
      await expect(mutate).rejects.toThrow("read-only");
      await expect(readLocal(skill)).resolves.toBe("managed instructions");
    },
  );

  it("creates mirror files exclusively before syncing them", async () => {
    await expect(
      bridge.createFileExclusive({ filePath: "nested/file.txt", data: "first" }),
    ).resolves.toBe("created");
    await expect(
      bridge.createFileExclusive({ filePath: "nested/file.txt", data: "replacement" }),
    ).resolves.toBe("exists");
    await expect(readLocal("nested/file.txt")).resolves.toBe("first");
    expect(backend.syncLocalPathToRemote).toHaveBeenCalledTimes(1);
  });

  it("keeps the canonical local exclusive create when mirror sync fails", async () => {
    backend.syncLocalPathToRemote.mockRejectedValue(new Error("remote rejected"));
    await expect(
      bridge.createFileExclusive({ filePath: "file.txt", data: "canonical" }),
    ).rejects.toThrow("remote rejected");
    await expect(readLocal("file.txt")).resolves.toBe("canonical");
  });

  it("rejects cross-root mirror renames before the remote backend commit", async () => {
    await using agent = await createOpenShellTestWorkspace("agent-fs");
    await seedLocal("source.txt");
    bridge = createBridge({ agentWorkspaceDir: agent.dir });
    await expect(bridge.rename({ from: "source.txt", to: "/agent/source.txt" })).rejects.toThrow(
      "OpenShell cross-root mirror renames require pinned fs-safe support",
    );
    expect(backend.renameRemotePath).not.toHaveBeenCalled();
    await expect(readLocal("source.txt")).resolves.toBe("payload");
    await expectPathMissing(path.join(agent.dir, "source.txt"));
    await expect(fs.readdir(agent.dir)).resolves.toStrictEqual([]);
  });

  it.runIf(process.platform !== "win32").each([
    { link: "symlink", error: "Sandbox symlink rename sources are not supported" },
    { link: "link", error: "Sandbox hardlinked rename sources are not supported" },
  ] as const)(
    "rejects $link rename sources before the remote backend commit",
    async ({ link, error }) => {
      await seedLocal("target.txt");
      await fs[link](link === "symlink" ? "target.txt" : local("target.txt"), local("link.txt"));
      await expect(bridge.rename({ from: "link.txt", to: "moved.txt" })).rejects.toThrow(error);
      expect(backend.renameRemotePath).not.toHaveBeenCalled();
      await expect(readLocal("link.txt")).resolves.toBe("payload");
      if (link === "symlink") {
        await expect(fs.readlink(local("link.txt"))).resolves.toBe("target.txt");
      }
      await expectPathMissing(local("moved.txt"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes recursive mirror directories without following symlink leaves",
    async () => {
      await using outside = await createOpenShellTestWorkspace("outside");
      const target = path.join(outside.dir, "target.txt");
      await fs.mkdir(local("nested"));
      await fs.writeFile(target, "outside");
      await fs.symlink(target, local("nested/link.txt"));
      await fs.symlink(outside.dir, local("nested/directory-link"));
      await fs.symlink("missing", local("nested/dangling-link"));
      await bridge.remove({ filePath: "nested", recursive: true, force: true });
      await expectPathMissing(local("nested"));
      await expect(fs.readFile(target, "utf8")).resolves.toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "unlinks a mirror symlink without removing its target",
    async () => {
      await using outside = await createOpenShellTestWorkspace("outside");
      const target = path.join(outside.dir, "target.txt");
      await fs.writeFile(target, "outside");
      await fs.symlink(target, local("link.txt"));
      await bridge.remove({ filePath: "link.txt", force: false, recursive: false });
      await expectPathMissing(local("link.txt"));
      await expect(fs.readFile(target, "utf8")).resolves.toBe("outside");
      expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/link.txt", {
        recursive: false,
        signal: undefined,
        ignoreMissing: false,
      });
    },
  );

  it("preserves missing local mirror path handling", async () => {
    await expect(
      bridge.remove({ filePath: "missing", recursive: false, force: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(bridge.remove({ filePath: "missing", recursive: false })).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32").each([
    {
      method: "mkdirpRemotePath",
      mutate: () => bridge.mkdirp({ filePath: "slot/escaped" }),
      escaped: "escaped",
    },
    {
      method: "removeRemotePath",
      mutate: () => bridge.remove({ filePath: "slot/target.txt", force: true }),
      escaped: "target.txt",
    },
    {
      method: "renameRemotePath",
      mutate: () => bridge.rename({ from: "source.txt", to: "slot/parent/moved.txt" }),
      escaped: "parent/moved.txt",
    },
  ] as const)("rejects a parent swap after $method", async ({ method, mutate, escaped }) => {
    await using outside = await createOpenShellTestWorkspace("outside");
    await seedLocal("slot/target.txt", "inside");
    await seedLocal("source.txt");
    const outsideTarget = path.join(outside.dir, escaped);
    if (method === "removeRemotePath") {
      await fs.writeFile(outsideTarget, "outside");
    }
    backend[method].mockImplementation(async () => {
      await fs.rm(local("slot"), { recursive: true, force: true });
      await fs.symlink(outside.dir, local("slot"));
    });
    await expect(mutate()).rejects.toThrow();
    if (method === "removeRemotePath") {
      await expect(fs.readFile(outsideTarget, "utf8")).resolves.toBe("outside");
    } else {
      await expectPathMissing(outsideTarget);
    }
    if (method === "renameRemotePath") {
      await expect(readLocal("source.txt")).resolves.toBe("payload");
    }
  });

  it("rejects symlink-parent writes instead of escaping the local mount root", async () => {
    await using outside = await createOpenShellTestWorkspace("outside");
    await fs.symlink(outside.dir, local("alias"));
    await expect(
      bridge.writeFile({ filePath: "alias/escape.txt", data: "owned", mkdir: true }),
    ).rejects.toThrow();
    await expectPathMissing(path.join(outside.dir, "escape.txt"));
    await expect(fs.readdir(outside.dir)).resolves.toStrictEqual([]);
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
  });

  it("rejects writes and creates whose final target is a symlink inside the local mount root", async () => {
    await seedLocal("existing.txt", "keep");
    await fs.symlink("existing.txt", local("link.txt"));
    await expect(
      bridge.writeFile({ filePath: "link.txt", data: "owned", mkdir: true }),
    ).rejects.toThrow();
    await expect(
      bridge.createFileExclusive({ filePath: "link.txt", data: "owned" }),
    ).rejects.toThrow();
    await expect(fs.readlink(local("link.txt"))).resolves.toBe("existing.txt");
    await expect(readLocal("existing.txt")).resolves.toBe("keep");
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
  });

  it("rejects a parent symlink that lands outside the sandbox root", async () => {
    await using outside = await createOpenShellTestWorkspace("outside");
    await fs.writeFile(path.join(outside.dir, "secret.txt"), "outside");
    await fs.symlink(outside.dir, local("subdir"));
    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
    await expect(bridge.readDirectory({ filePath: "subdir" })).rejects.toThrow();
  });

  it("reads regular files and directories through the shared safe fs root", async () => {
    await fs.mkdir(local("subdir/nested"), { recursive: true });
    await seedLocal("subdir/secret.txt", "inside");
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
      local("subdir"),
      local("alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(bridge.readDirectory({ filePath: "alias" })).rejects.toThrow();
  });

  it("keeps literal tilde directories inside the mirror workspace", async () => {
    await seedLocal("~/file.txt", "literal");
    await expect(bridge.readFile({ filePath: "./~/file.txt" })).resolves.toEqual(
      Buffer.from("literal"),
    );
    await expect(bridge.readDirectory({ filePath: "./~" })).resolves.toEqual([
      { name: "file.txt", isDirectory: false },
    ]);
    await bridge.writeFile({ filePath: "./~/file.txt", data: "updated" });
    await expect(readLocal("~/file.txt")).resolves.toBe("updated");
    await expect(
      bridge.createFileExclusive({ filePath: "./~/created.txt", data: "created" }),
    ).resolves.toBe("created");
    await bridge.mkdirp({ filePath: "./~/nested" });
    expect((await fs.stat(local("~/nested"))).isDirectory()).toBe(true);
    expect(backend.mkdirpRemotePath).toHaveBeenCalledWith("/sandbox/~/nested", undefined);
    await bridge.rename({ from: "./~/created.txt", to: "./~/nested/target/moved.txt" });
    expect(backend.renameRemotePath).toHaveBeenCalledWith(
      "/sandbox/~/created.txt",
      "/sandbox/~/nested/target/moved.txt",
      undefined,
    );
    await expect(readLocal("~/nested/target/moved.txt")).resolves.toBe("created");
    await bridge.remove({ filePath: "./~/file.txt", force: false });
    expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/~/file.txt", {
      recursive: false,
      signal: undefined,
      ignoreMissing: false,
    });
    await expectPathMissing(local("~/file.txt"));
    await bridge.remove({ filePath: ".", recursive: true });
    await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
  });

  it("reads materialized skills through protected mounts instead of workspace shadows", async () => {
    const skillsWorkspaceDir = local("materialized");
    const skill = "materialized/skills/demo/SKILL.md";
    const virtual = ".openclaw/sandbox-skills/skills/demo/SKILL.md";
    const text = "# Demo\nmaterialized\n";
    await seedLocal(skill, text);
    await seedLocal("materialized/skills/demo/examples.md", "examples");
    await seedLocal(virtual, "# Demo\nworkspace shadow\n");
    bridge = createBridge({ skillsWorkspaceDir });
    await expect(
      bridge.readDirectory({ filePath: path.posix.dirname(`/sandbox/${virtual}`) }),
    ).resolves.toEqual([
      { name: "SKILL.md", isDirectory: false },
      { name: "examples.md", isDirectory: false },
    ]);
    await expect(bridge.readFile({ filePath: `/sandbox/${virtual}` })).resolves.toEqual(
      Buffer.from(text),
    );
    await expect(bridge.readFile({ filePath: virtual })).resolves.toEqual(Buffer.from(text));
    await expect(bridge.writeFile({ filePath: virtual, data: "owned" })).rejects.toThrow(
      /read-only/,
    );
    await expect(bridge.writeFile({ filePath: local(virtual), data: "owned" })).rejects.toThrow(
      /read-only/,
    );
    await expect(bridge.writeFile({ filePath: local(skill), data: "owned" })).rejects.toThrow(
      /read-only/,
    );
    await expect(readLocal(skill)).resolves.toContain("materialized");
    expect(await readLocal(virtual)).toContain("workspace shadow");
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
  });

  it.each(["symlink", "link"] as const)("rejects reads through a %s leaf", async (link) => {
    await using outside = await createOpenShellTestWorkspace("outside");
    const source = path.join(outside.dir, "secret.txt");
    await fs.mkdir(local("subdir"));
    await fs.writeFile(source, "outside");
    await fs[link](source, local("subdir/secret.txt"));
    await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(
      "Sandbox boundary checks failed",
    );
  });

  it("maps agent mount paths when the sandbox workspace is read-only", async () => {
    await using agent = await createOpenShellTestWorkspace("agent");
    await fs.writeFile(path.join(agent.dir, "note.txt"), "agent");
    backend.remoteAgentWorkspaceDir = "/native-agent-root";
    bridge = createBridge({ agentWorkspaceDir: agent.dir, workspaceAccess: "ro" });
    expect(bridge.pathMappings).toContainEqual({
      hostRoot: path.resolve(agent.dir),
      containerRoot: "/native-agent-root",
    });
    expect(bridge.resolvePath({ filePath: "/native-agent-root/note.txt" }).hostPath).toBe(
      path.join(agent.dir, "note.txt"),
    );
    await expect(bridge.readFile({ filePath: "/native-agent-root/note.txt" })).resolves.toEqual(
      Buffer.from("agent"),
    );
    await expect(bridge.readDirectory({ filePath: "/native-agent-root" })).resolves.toEqual([
      { name: "note.txt", isDirectory: false },
    ]);
  });

  it.each([
    ["/sandbox/agent/project", "/sandbox/agent", "/sandbox/agent/project/note.txt", "workspace"],
    ["/sandbox", "/sandbox/nested/agent", "nested/agent/note.txt", "agent"],
    ["/sandbox", "/sandbox", "note.txt", "workspace"],
  ] as const)(
    "routes %s / %s path %s to %s",
    async (workspaceRemote, agentRemote, target, owner) => {
      await using agent = await createOpenShellTestWorkspace("agent");
      backend.remoteAgentWorkspaceDir = agentRemote;
      bridge = createBridge({
        agentWorkspaceDir: agent.dir,
        workspaceAccess: "ro",
        containerWorkdir: workspaceRemote,
      });
      expect(bridge.resolvePath({ filePath: target }).hostPath).toBe(
        path.join(owner === "agent" ? agent.dir : workspaceDir, "note.txt"),
      );
    },
  );
});
