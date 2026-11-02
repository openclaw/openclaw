import fs from "node:fs/promises";
import path from "node:path";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it } from "vitest";
import { OpenShellFsBridge } from "./fs-bridge.js";
import {
  createMirrorBackendMock,
  createOpenShellTestWorkspace as tempWorkspace,
  expectPathMissing,
} from "./openshell-fs.test-support.js";

const mutationMethods = ["mkdirpRemotePath", "removeRemotePath", "renameRemotePath"] as const;
const strictRemove = { recursive: false, signal: undefined, ignoreMissing: false };
const boundaryError = "Sandbox boundary checks failed";

let workspaceDir: string;
const agentDir = () => path.join(workspaceDir, "..", "agent");
const outsideDir = () => path.join(workspaceDir, "..", "outside");
let backend: ReturnType<typeof createMirrorBackendMock>;
let bridge: OpenShellFsBridge;
const local = (filePath: string) => path.join(workspaceDir, filePath);
const readLocal = (filePath: string) => fs.readFile(local(filePath), "utf8");
const write = (filePath: string, data = "owned", mkdir?: boolean) =>
  bridge.writeFile({ filePath, data, mkdir });
const create = (filePath: string, data = "owned") => bridge.createFileExclusive({ filePath, data });
const rename = (from: string, to: string) => bridge.rename({ from, to });
async function outsideFile(name = "target.txt") {
  const target = path.join(outsideDir(), name);
  await fs.writeFile(target, "outside");
  return { dir: outsideDir(), target };
}
const expectRead = (filePath: string, text: string, maxBytes?: number) =>
  expect(bridge.readFile({ filePath, maxBytes })).resolves.toEqual(Buffer.from(text));
async function expectDirectory(filePath: string, entries: Record<string, boolean>, cwd?: string) {
  const expected = Object.entries(entries).map(([name, isDirectory]) => ({ name, isDirectory }));
  await expect(bridge.readDirectory({ filePath, cwd })).resolves.toEqual(expected);
}
async function seedLocal(filePath: string, data = "payload") {
  await fs.mkdir(path.dirname(local(filePath)), { recursive: true });
  await fs.writeFile(local(filePath), data);
}
async function rejectMutation(method: (typeof mutationMethods)[number], swapParent = false) {
  const mkdir = method === "mkdirpRemotePath";
  const remove = method === "removeRemotePath";
  const relative = mkdir ? "escaped" : remove ? "target.txt" : "parent/moved.txt";
  const target = swapParent ? `slot/${relative}` : "nested/target.txt";
  await seedLocal("source.txt");
  if (swapParent) {
    await seedLocal("slot/target.txt", "inside");
    if (remove) {
      await fs.writeFile(path.join(outsideDir(), relative), "outside");
    }
    backend[method].mockImplementation(async () => {
      await fs.rm(local("slot"), { recursive: true, force: true });
      await fs.symlink(outsideDir(), local("slot"));
    });
  } else {
    backend[method].mockRejectedValue(new Error("remote rejected"));
  }
  const mutation = mkdir
    ? bridge.mkdirp({ filePath: target })
    : remove
      ? bridge.remove({ filePath: swapParent ? target : "source.txt", force: true })
      : rename("source.txt", target);
  await expect(mutation).rejects.toThrow(swapParent ? undefined : "remote rejected");
  if (swapParent && remove) {
    await expect(fs.readFile(path.join(outsideDir(), relative), "utf8")).resolves.toBe("outside");
  } else if (swapParent) {
    await expectPathMissing(path.join(outsideDir(), relative));
  } else if (!remove) {
    await expectPathMissing(local(mkdir ? "nested" : target));
  }
  expect(await readLocal("source.txt")).toBe("payload");
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
  return new OpenShellFsBridge(sandbox, backend);
}
beforeEach(async ({ onTestFinished }) => {
  const workspace = await tempWorkspace("fs");
  onTestFinished(() => workspace[Symbol.asyncDispose]());
  workspaceDir = path.join(workspace.dir, "workspace");
  await Promise.all([workspaceDir, agentDir(), outsideDir()].map((dir) => fs.mkdir(dir)));
  backend = createMirrorBackendMock();
  bridge = createBridge();
});

it.each([
  ["none", "write"],
  ["ro", "write"],
  ["rw", "remove"],
  ["rw", "rename"],
] as const)("%s access guards %s", async (workspaceAccess, mutation) => {
  bridge = createBridge({ workspaceAccess });
  if (workspaceAccess === "ro") {
    await expect(write("file.txt", "blocked")).rejects.toThrow("read-only");
    expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
    return;
  }
  await write("nested/file.txt", "hello", true);
  expect(await readLocal("nested/file.txt")).toBe("hello");
  expect(backend.syncLocalPathToRemote).toHaveBeenCalledWith(
    local("nested/file.txt"),
    "/sandbox/nested/file.txt",
  );
  const skill = mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
  await seedLocal(skill, "managed instructions");
  const mutate =
    mutation === "write"
      ? write(skill, "changed")
      : mutation === "remove"
        ? bridge.remove({ filePath: ".agents", recursive: true })
        : rename(".agents", "moved-instructions");
  await expect(mutate).rejects.toThrow("read-only");
  await expect(readLocal(skill)).resolves.toBe("managed instructions");
});

it("creates mirror files exclusively before syncing them", async () => {
  const filePath = "nested/file.txt";
  await expect(create(filePath, "first")).resolves.toBe("created");
  await expect(create(filePath, "replacement")).resolves.toBe("exists");
  expect(await readLocal(filePath)).toBe("first");
  expect(backend.syncLocalPathToRemote).toHaveBeenCalledTimes(1);
});

it("keeps the canonical local exclusive create when mirror sync fails", async () => {
  backend.syncLocalPathToRemote.mockRejectedValue(new Error("remote rejected"));
  await expect(create("file.txt", "canonical")).rejects.toThrow("remote rejected");
  await expect(readLocal("file.txt")).resolves.toBe("canonical");
});

it("rejects cross-root mirror renames before remote commit", async () => {
  await seedLocal("source.txt");
  bridge = createBridge({ agentWorkspaceDir: agentDir() });
  await expect(rename("source.txt", "/agent/source.txt")).rejects.toThrow(
    "OpenShell cross-root mirror renames require pinned fs-safe support",
  );
  expect(backend.renameRemotePath).not.toHaveBeenCalled();
  expect(await readLocal("source.txt")).toBe("payload");
  await expect(fs.readdir(agentDir())).resolves.toStrictEqual([]);
});

it.runIf(process.platform !== "win32").each([
  ["symlink", "Sandbox symlink rename sources are not supported"],
  ["link", "Sandbox hardlinked rename sources are not supported"],
] as const)("rejects %s renames before remote commit", async (kind, error) => {
  await seedLocal("source.txt");
  await fs[kind](kind === "symlink" ? "source.txt" : local("source.txt"), local("link.txt"));
  await expect(rename("link.txt", "moved.txt")).rejects.toThrow(error);
  expect(backend.renameRemotePath).not.toHaveBeenCalled();
  expect(await readLocal("link.txt")).toBe("payload");
  if (kind === "symlink") {
    await expect(fs.readlink(local("link.txt"))).resolves.toBe("source.txt");
  }
  await expectPathMissing(local("moved.txt"));
});

it.runIf(process.platform !== "win32").each([false, true])(
  "removes symlinks safely (recursive=%s)",
  async (recursive) => {
    const outside = await outsideFile();
    const filePath = recursive ? "nested" : "link.txt";
    if (recursive) {
      await fs.mkdir(local("nested"));
      await fs.symlink(outside.dir, local("nested/directory-link"));
      await fs.symlink("missing", local("nested/dangling-link"));
    }
    await fs.symlink(outside.target, local(recursive ? "nested/link.txt" : filePath));
    await bridge.remove({ filePath, recursive, force: recursive });
    await expectPathMissing(local(filePath));
    await expect(fs.readFile(outside.target, "utf8")).resolves.toBe("outside");
    if (!recursive) {
      expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/link.txt", strictRemove);
    }
  },
);

it("preserves missing local mirror path handling", async () => {
  await expect(
    bridge.remove({ filePath: "missing", recursive: false, force: false }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(bridge.remove({ filePath: "missing", recursive: false })).resolves.toBeUndefined();
});

it.each(mutationMethods)("keeps local state when %s is rejected", (method) =>
  rejectMutation(method),
);
it.runIf(process.platform !== "win32").each(mutationMethods)(
  "rejects a parent swap after %s",
  (method) => rejectMutation(method, true),
);

it("rejects symlink-parent writes instead of escaping the local mount root", async () => {
  await fs.symlink(outsideDir(), local("alias"));
  await expect(write("alias/escape.txt", "owned", true)).rejects.toThrow();
  await expect(fs.readdir(outsideDir())).resolves.toStrictEqual([]);
  expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
});

it("rejects writes and creates whose final target is a symlink inside the local mount root", async () => {
  await seedLocal("existing.txt", "keep");
  await fs.symlink("existing.txt", local("link.txt"));
  await expect(write("link.txt", "owned", true)).rejects.toThrow();
  await expect(create("link.txt")).rejects.toThrow();
  await expect(fs.readlink(local("link.txt"))).resolves.toBe("existing.txt");
  expect(await readLocal("existing.txt")).toBe("keep");
  expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
});

it.each(["parent", "symlink", "link"] as const)("rejects %s reads", async (kind) => {
  const outside = await outsideFile("secret.txt");
  if (kind === "parent") {
    await fs.symlink(outside.dir, local("subdir"));
  } else {
    await fs.mkdir(local("subdir"));
    await fs[kind](outside.target, local("subdir/secret.txt"));
  }
  await expect(bridge.readFile({ filePath: "subdir/secret.txt" })).rejects.toThrow(boundaryError);
  if (kind === "parent") {
    await expect(bridge.readDirectory({ filePath: "subdir" })).rejects.toThrow();
  }
});

it("reads literal relative paths and directories through the safe fs root", async () => {
  await fs.mkdir(local(" subdir/nested"), { recursive: true });
  await seedLocal(" subdir/secret.txt", "inside");
  await expectDirectory(".", { " subdir": true });
  await expectDirectory(".", { nested: true, "secret.txt": false }, "/sandbox/ subdir");
  await expectRead(" subdir/secret.txt", "inside", 6);
  await expect(bridge.readFile({ filePath: " subdir/secret.txt", maxBytes: 5 })).rejects.toThrow(
    boundaryError,
  );
  await fs.symlink(
    local(" subdir"),
    local("alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(bridge.readDirectory({ filePath: "alias" })).rejects.toThrow();
});

it("keeps literal tilde directories inside the mirror workspace", async () => {
  await seedLocal("~/file.txt", "literal");
  await expectRead("./~/file.txt", "literal");
  await expectDirectory("./~", { "file.txt": false });
  await write("./~/file.txt", "updated");
  expect(await readLocal("~/file.txt")).toBe("updated");
  await expect(create("./~/created.txt", "created")).resolves.toBe("created");
  await bridge.mkdirp({ filePath: "./~/nested" });
  expect((await fs.stat(local("~/nested"))).isDirectory()).toBe(true);
  expect(backend.mkdirpRemotePath).toHaveBeenCalledWith("/sandbox/~/nested", undefined);
  await rename("./~/created.txt", "./~/nested/target/moved.txt");
  expect(backend.renameRemotePath).toHaveBeenCalledWith(
    "/sandbox/~/created.txt",
    "/sandbox/~/nested/target/moved.txt",
    undefined,
  );
  expect(await readLocal("~/nested/target/moved.txt")).toBe("created");
  await bridge.remove({ filePath: "./~/file.txt", force: false });
  expect(backend.removeRemotePath).toHaveBeenCalledWith("/sandbox/~/file.txt", strictRemove);
  await expectPathMissing(local("~/file.txt"));
  await bridge.remove({ filePath: ".", recursive: true });
  await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
});

it("reads materialized skills through protected mounts instead of workspace shadows", async () => {
  const skillsWorkspaceDir = local("materialized");
  const skill = "materialized/skills/demo/SKILL.md";
  const virtual = ".openclaw/sandbox-skills/skills/demo/SKILL.md";
  const mounted = `/sandbox/${virtual}`;
  const text = "# Demo\nmaterialized\n";
  await seedLocal(skill, text);
  await seedLocal("materialized/skills/demo/examples.md", "examples");
  await seedLocal(virtual, "# Demo\nworkspace shadow\n");
  bridge = createBridge({ skillsWorkspaceDir });
  await expectDirectory(path.posix.dirname(mounted), { "SKILL.md": false, "examples.md": false });
  await expectRead(mounted, text);
  await expectRead(virtual, text);
  for (const filePath of [virtual, local(virtual), local(skill)]) {
    await expect(write(filePath)).rejects.toThrow(/read-only/);
  }
  await expect(readLocal(skill)).resolves.toContain("materialized");
  expect(await readLocal(virtual)).toContain("workspace shadow");
  expect(backend.syncLocalPathToRemote).not.toHaveBeenCalled();
});

it.each([
  ["/sandbox", "/native-agent-root", "/native-agent-root/note.txt", "agent"],
  ["/sandbox/agent/project", "/sandbox/agent", "/sandbox/agent/project/note.txt", "workspace"],
  ["/sandbox", "/sandbox/nested/agent", "nested/agent/note.txt", "agent"],
  ["/sandbox", "/sandbox", "note.txt", "workspace"],
] as const)("routes %s / %s path %s to %s", async (workspace, agent, target, owner) => {
  backend.remoteAgentWorkspaceDir = agent;
  bridge = createBridge({
    agentWorkspaceDir: agentDir(),
    workspaceAccess: "ro",
    containerWorkdir: workspace,
  });
  expect(bridge.resolvePath({ filePath: target }).hostPath).toBe(
    path.join(owner === "agent" ? agentDir() : workspaceDir, "note.txt"),
  );
  if (agent === "/native-agent-root") {
    await fs.writeFile(path.join(agentDir(), "note.txt"), "agent");
    expect(bridge.pathMappings).toContainEqual({
      hostRoot: path.resolve(agentDir()),
      containerRoot: agent,
    });
    await expectRead(target, "agent");
    await expectDirectory(agent, { "note.txt": false });
  }
});
