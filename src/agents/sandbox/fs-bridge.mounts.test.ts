import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { bindHostSkillCatalog } from "../harness/host-skills.js";
import { readInstalledSkill } from "../installed-skill-catalog.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxFileIdentity } from "./file-mutation-identity.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import {
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  dockerExecResult,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockContainerCanonicalPaths,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveWritableSandboxBindHostRoots } from "./fs-paths.js";

function mountedSandbox(
  dir: string,
  docker: Partial<ReturnType<typeof createSandbox>["docker"]> = {},
) {
  return createSandbox({
    workspaceDir: dir,
    agentWorkspaceDir: dir,
    workspaceAccess: "rw",
    docker: { ...createSandbox().docker, ...docker },
  });
}

function bridgeAt(root: string, docker: Parameters<typeof mountedSandbox>[1] = {}) {
  return createSandboxFsBridge({ sandbox: mountedSandbox(root, docker) });
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
  }
}

const readText = async (bridge: ReturnType<typeof bridgeAt>, filePath: string) =>
  (await bridge.readFile({ filePath })).toString();
const it = test.extend<{ root: string }>({
  root: async ({ task: _task }, use) => withTempDir("openclaw-effective-mounts-", use),
});

function guardTarget(root: string, relativePath: string) {
  const filePath = path.join(root, relativePath);
  return { containerPath: filePath, hostPath: filePath, relativePath, writable: true };
}

installFsBridgeTestHarness();

it("binds skills to guarded read sources", async ({ root }) => {
  const dir = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  await writeFiles(root, {
    "workspace/SKILL.md": "Inside instructions",
    "outside/SKILL.md": "Outside instructions",
  });
  const alias = path.join(dir, "alias.md");
  await fs.symlink("SKILL.md", alias);
  const sandbox = mountedSandbox(dir, { binds: [`${outsideDir}:/data:ro`] });
  const bridge = createSandboxFsBridge({ sandbox });
  sandbox.fsBridge = bridge;
  mockContainerCanonicalPaths({ "/workspace/alias.md": "/workspace/SKILL.md" });
  const source = await bridge.readFileWithSource!({ filePath: "alias.md", maxBytes: 64 });
  expect(source).toEqual({
    data: Buffer.from("Inside instructions"),
    canonicalPath: "/workspace/SKILL.md",
    workspaceRelativePath: "SKILL.md",
  });
  await expect(bridge.readFile({ filePath: "alias.md", maxBytes: 2 })).rejects.toThrow("exceeds");
  const skill = {
    ...createCanonicalFixtureSkill({
      name: "guide",
      description: "Guide",
      filePath: alias,
      baseDir: dir,
      source: "workspace",
    }),
    readContent: "Cached content must not bypass the bridge",
  };
  sandbox.skillUsagePaths = [
    {
      skillName: "guide",
      skillSource: "workspace",
      skillFile: alias,
      readPath: alias,
    },
  ];
  const getSkills = bindHostSkillCatalog({
    workspaceDir: dir,
    requiredRoot: dir,
    sandbox,
    readable: true,
    assertCurrent: () => {},
    snapshot: {
      prompt: "",
      skills: [{ name: "guide", skillKey: "guide" }],
      resolvedSkills: [],
      discoverySkills: [skill],
    },
  });
  const catalog = getSkills(null);
  await expect(readInstalledSkill(catalog, "guide")).resolves.toMatchObject({
    content: "Inside instructions",
  });
  await fs.unlink(alias);
  await fs.symlink("/data/SKILL.md", alias);
  mockContainerCanonicalPaths({ "/workspace/alias.md": "/data/SKILL.md" });
  const external = await bridge.readFileWithSource!({ filePath: "alias.md", maxBytes: 64 });
  expect(external).toEqual({
    data: Buffer.from("Outside instructions"),
    canonicalPath: "/data/SKILL.md",
  });
  await expect(bridge.readFile({ filePath: "alias.md" })).resolves.toEqual(external.data);
  await expect(readInstalledSkill(catalog, "guide")).rejects.toThrow(
    "escape the captured required workspace",
  );
});

it("uses the last global/agent bind and access mode", async ({ root: dir }) => {
  await writeFiles(dir, { "A/marker": "A", "B/marker": "B" });
  const { docker } = resolveSandboxConfigForAgent(
    {
      agents: {
        defaults: { sandbox: { scope: "agent", docker: { binds: [`${dir}/A:/data:rw`] } } },
        entries: { test: { sandbox: { docker: { binds: [`${dir}/B:/data/:ro`] } } } },
      },
    },
    "test",
  );
  const sandbox = mountedSandbox(dir, docker);
  const bridge = createSandboxFsBridge({ sandbox });
  expect(await readText(bridge, "/data/marker")).toBe("B");
  expect(bridge.resolvePath({ filePath: "/data/marker" }).hostPath).toBe(
    path.join(dir, "B/marker"),
  );
  expect(
    buildSandboxFsMounts(sandbox).filter((mount) => mount.containerRoot === "/data"),
  ).toHaveLength(1);
  expect(resolveWritableSandboxBindHostRoots(docker.binds)).toEqual([]);
  await expect(bridge.writeFile({ filePath: "/data/marker", data: "changed" })).rejects.toThrow(
    "read-only",
  );
  expectOnlyCanonicalPathCommands();
  expect(await fs.readFile(path.join(dir, "A/marker"), "utf8")).toBe("A");
});

it("denies tmpfs aliases but allows deeper binds", async ({ root: dir }) => {
  await writeFiles(dir, { "cache/marker": "HIDDEN", "export/marker": "VISIBLE" });
  await fs.symlink("cache/marker", path.join(dir, "alias"));
  const bridge = bridgeAt(dir, {
    tmpfs: ["/workspace/cache:rw"],
    binds: [`${dir}/export:/workspace/cache/export:ro`],
  });
  mockContainerCanonicalPaths({ "/workspace/alias": "/workspace/cache/marker" });
  for (const filePath of [
    "cache/marker",
    "/workspace/cache/marker",
    path.join(dir, "cache/marker"),
    "alias",
  ]) {
    await expect(bridge.readFile({ filePath })).rejects.toThrow("container-only");
  }
  expect(await readText(bridge, "cache/export/marker")).toBe("VISIBLE");
  await expect(
    bridge.writeFile({ filePath: "cache/export/marker", data: "changed" }),
  ).rejects.toThrow("read-only");
  expectOnlyCanonicalPathCommands();
});

it.runIf(process.platform !== "win32")("resolves mounted symlink hops", async ({ root }) => {
  const dir = path.join(root, "workspace");
  const replacement = path.join(root, "replacement");
  await writeFiles(root, { "workspace/visible.txt": "A", "replacement/hop": "B" });
  await fs.mkdir(path.join(dir, "cache"));
  await fs.symlink("../visible.txt", path.join(dir, "cache/hop"));
  await fs.symlink("cache/hop", path.join(dir, "alias"));
  await fs.symlink("/data/hop", path.join(dir, "absolute-alias"));
  await fs.symlink("hop", path.join(replacement, "data-link"));
  const bridge = bridgeAt(dir, {
    binds: [`${replacement}:/workspace/cache:ro`, `${replacement}:/data:ro`],
  });
  mockContainerCanonicalPaths({
    "/workspace/alias": "/workspace/cache/hop",
    "/workspace/absolute-alias": "/data/hop",
    "/data/data-link": "/data/hop",
  });
  for (const filePath of ["alias", "absolute-alias", "/workspace/cache/hop", "/data/hop"]) {
    expect(await readText(bridge, filePath)).toBe("B");
    await expect(bridge.stat({ filePath })).resolves.not.toBeNull();
    expect(await resolveSandboxFileIdentity({ bridge, filePath })).toBe(
      path.join(replacement, "hop"),
    );
  }
  for (const [filePath, expected] of [
    ["alias", "/workspace/cache/hop"],
    ["absolute-alias", "/data/hop"],
    ["/data/hop", "/data/hop"],
    ["/data/data-link", "/data/hop"],
  ]) {
    expect(await bridge.resolveReadPolicyPath!({ filePath })).toBe(expected);
  }
  const aliasPolicy = await bridge.resolveReadPolicyPath!({ filePath: "alias" });
  await expect(
    bridge.stat({ filePath: "alias", expectedPolicyPath: aliasPolicy }),
  ).resolves.toMatchObject({
    type: "file",
    size: 1,
    mtimeMs: Math.trunc((await fs.stat(path.join(replacement, "hop"))).mtimeMs),
  });
  for (const [action, filePath, expectedPolicyPath] of [
    ["readFile", "absolute-alias", "/workspace/cache/hop"],
    ["readFile", "/data/hop", "/workspace/cache/hop"],
    ["stat", "/data/hop", "/workspace/cache/hop"],
    ["stat", "/data/hop", ""],
  ] as const) {
    await expect(bridge[action]({ filePath, expectedPolicyPath })).rejects.toThrow(
      "changed after authorization",
    );
  }
  expect(await fs.readFile(path.join(dir, "visible.txt"), "utf8")).toBe("A");
  expect(
    mockedOpenRootFile.mock.calls.every(
      ([request]) => request.absolutePath === path.join(replacement, "hop"),
    ),
  ).toBe(true);
});

it.runIf(process.platform !== "win32")("closes swapped-path descriptors", async ({ root: dir }) => {
  const target = "a\\b";
  const other = "a/b";
  await writeFiles(dir, { [target]: "VISIBLE", [other]: "HIDDEN" });
  const bridge = bridgeAt(dir);
  const open = mockedOpenRootFile.getMockImplementation()!;
  let fd: number | undefined;
  let closeCallOffset = 0;
  const close = vi.spyOn(fsSync, "closeSync");
  try {
    mockedOpenRootFile.mockImplementationOnce(async (request) => {
      await fs.unlink(path.join(dir, target));
      await fs.symlink(other, path.join(dir, target));
      const result = await open(request);
      if (result.ok) {
        fd = result.fd;
        closeCallOffset = close.mock.calls.length;
      }
      return result;
    });
    await expect(bridge.readFile({ filePath: path.join(dir, target) })).rejects.toThrow(
      "hidden by another mount",
    );
    expect(fd).toBeDefined();
    // A released descriptor number can already identify another resource.
    const closeIndex = close.mock.calls.findIndex(
      ([descriptor], index) => index >= closeCallOffset && descriptor === fd,
    );
    expect(closeIndex).toBeGreaterThanOrEqual(closeCallOffset);
    expect(close.mock.results[closeIndex]).toEqual({ type: "return", value: undefined });
    expect(await fs.readFile(path.join(dir, other), "utf8")).toBe("HIDDEN");
    expectOnlyCanonicalPathCommands();
  } finally {
    close.mockRestore();
  }
});

it.runIf(process.platform !== "win32").each(["readFile", "stat"] as const)(
  "rejects descriptor retargeting through %s",
  async (action) => {
    await withTempDir("openclaw-effective-mounts-", async (dir) => {
      await writeFiles(dir, { visible: "VISIBLE", hidden: "HIDDEN" });
      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir: dir, agentWorkspaceDir: dir }),
      });
      mockContainerCanonicalPaths({ "/workspace/alias": "/workspace/hidden" });
      const open = mockedOpenRootFile.getMockImplementation()!;
      mockedOpenRootFile.mockImplementationOnce(async (request) => {
        const opened = await open(request);
        await fs.unlink(path.join(dir, "hidden"));
        await fs.symlink("visible", path.join(dir, "hidden"));
        return opened;
      });

      await expect(
        bridge[action]({ filePath: "alias", expectedPolicyPath: "/workspace/visible" }),
      ).rejects.toThrow("changed after authorization");
    });
  },
);

it.runIf(process.platform !== "win32")("reads backslash roots", async ({ root }) => {
  const dir = path.join(root, "workspace\\part");
  const decoy = path.join(root, "workspace/part");
  await writeFiles(root, {
    "workspace\\part/marker": "LITERAL_ROOT",
    "workspace/part/marker": "SLASH_ROOT_DECOY",
  });
  const bridge = bridgeAt(dir);
  expect(await readText(bridge, "marker")).toBe("LITERAL_ROOT");
  expect(await resolveSandboxFileIdentity({ bridge, filePath: "marker" })).toBe(
    path.join(dir, "marker"),
  );
  expect(await fs.readFile(path.join(decoy, "marker"), "utf8")).toBe("SLASH_ROOT_DECOY");
});

it.runIf(process.platform === "darwin")("uses physical casing", async ({ root }) => {
  const dir = path.join(root, "Workspace");
  await writeFiles(dir, { "Private/secret.txt": "secret" });
  try {
    await fs.stat(path.join(dir, "private/SECRET.txt"));
  } catch {
    return;
  }
  const bridge = createSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir: dir, agentWorkspaceDir: dir }),
  });

  expect(await bridge.resolveReadPolicyPath!({ filePath: "private/SECRET.txt" })).toBe(
    "/workspace/Private/secret.txt",
  );
});

it("container identities do not authorize host reads", async ({ root: dir }) => {
  await writeFiles(dir, { "cache/value": "HIDDEN" });
  const bridge = bridgeAt(dir, { tmpfs: ["/workspace/cache"] });
  mockContainerCanonicalPaths({
    "/workspace/alias": "/workspace/cache/value",
    "/workspace/outside": "/outside/value",
  });
  for (const [filePath, canonical] of [
    ["alias", "/workspace/cache/value"],
    ["outside", "/outside/value"],
  ] as const) {
    expect(await resolveSandboxFileIdentity({ bridge, filePath })).toBe(`container:${canonical}`);
    await expect(bridge.readFile({ filePath })).rejects.toThrow(
      /container-only|escapes allowed mounts/,
    );
  }
  expect(mockedOpenRootFile).not.toHaveBeenCalled();
});

it.runIf(process.platform !== "win32")("preserves shell path bytes", async ({ root: dir }) => {
  await fs.symlink("missing/target", path.join(dir, "dangling"));
  await fs.symlink("loop", path.join(dir, "loop"));
  await fs.mkdir(path.join(dir, "directory\n"));
  await fs.symlink("missing/target", path.join(dir, "directory\n/dangling\n"));
  await writeFiles(dir, {
    "value\n": "VISIBLE_NEWLINE_TARGET",
    value: "WRONG_TRIMMED_SIBLING",
  });
  await fs.symlink("value\n", path.join(dir, "alias"));
  const guard = new SandboxFsPathGuard({
    mountsByContainer: [{ hostRoot: dir, containerRoot: dir, writable: true, source: "workspace" }],
    runCommand: async (script, options) => {
      const { stdout } = await promisify(execFile)(
        "sh",
        ["-c", script, "identity-test", ...(options?.args ?? [])],
        { encoding: "buffer" },
      );
      return { stdout };
    },
  });
  const aliasTarget = guardTarget(dir, "alias");
  const opened = await guard.openReadableFile(aliasTarget);
  try {
    expect(fsSync.readFileSync(opened.fd, "utf8")).toBe("VISIBLE_NEWLINE_TARGET");
  } finally {
    fsSync.closeSync(opened.fd);
  }
  expect(await guard.resolveFileIdentity(aliasTarget)).toBe(path.join(dir, "value\n"));
  for (const relativePath of [
    "",
    "dangling",
    "loop",
    "missing/leaf",
    "missing\n/leaf\n",
    "directory\n/missing\n/leaf\n",
    "directory\n/dangling\n",
  ]) {
    const filePath = path.join(dir, relativePath);
    const target = guardTarget(dir, relativePath);
    expect(await guard.resolveFileIdentity(target)).toBe(filePath);
  }
  const danglingTarget = guardTarget(dir, "directory\n/dangling\n");
  await expect(guard.openReadableFile(danglingTarget)).rejects.toThrow();
  expect(await guard.resolveAnchoredSandboxEntry(danglingTarget, "unlink files")).toEqual({
    canonicalParentPath: path.join(dir, "directory\n"),
    basename: "dangling\n",
  });
  for (const name of ["dangling", "loop", "directory\n/dangling\n"]) {
    expect((await fs.lstat(path.join(dir, name))).isSymbolicLink()).toBe(true);
  }
  expect(await fs.readFile(path.join(dir, "value"), "utf8")).toBe("WRONG_TRIMMED_SIBLING");
});

it.each(["same", ...(process.platform === "win32" ? [] : ["canonical"])])(
  "prefers the workspace alias over %s custom sources",
  async (source) => {
    await withTempDir("openclaw-effective-mounts-", async (root) => {
      const actualWorkspace = path.join(root, "project/work");
      const dir = source === "canonical" ? path.join(root, "ws") : actualWorkspace;
      const replacement = path.join(root, "replacement");
      await fs.mkdir(actualWorkspace, { recursive: true });
      if (dir !== actualWorkspace) {
        await fs.symlink(actualWorkspace, dir, "dir");
      }
      await writeFiles(root, { "replacement/marker": "VISIBLE" });
      await writeFiles(dir, { marker: "HIDDEN" });
      const bridge = bridgeAt(dir, {
        binds: [
          ...(source === "canonical" ? [] : [`${actualWorkspace}:/data:rw`]),
          `${replacement}:/workspace:ro`,
        ],
      });
      for (const filePath of [
        "marker",
        path.join(dir, "marker"),
        "/workspace/marker",
        ...(source === "canonical" ? [path.join(actualWorkspace, "marker")] : []),
      ]) {
        expect(await readText(bridge, filePath)).toBe("VISIBLE");
        await expect(bridge.writeFile({ filePath, data: "changed" })).rejects.toThrow("read-only");
      }
      if (source !== "canonical") {
        expect(await readText(bridge, "/data/marker")).toBe("HIDDEN");
      }
    });
  },
);

it.runIf(process.platform !== "win32")("preserves bind whitespace", async ({ root: dir }) => {
  await writeFiles(dir, { "A/marker": "A", "B /marker": "B " });
  const sandbox = mountedSandbox(dir, {
    binds: [`${dir}/A:/data:ro`, `${dir}/B :/data :rw`],
  });
  const bridge = createSandboxFsBridge({ sandbox });
  expect(await readText(bridge, "/data/marker")).toBe("A");
  expect(await readText(bridge, "/data /marker")).toBe("B ");
  expect(bridge.resolvePath({ filePath: "/data " }).hostPath).toBe(path.join(dir, "B "));
  expect(resolveWritableSandboxBindHostRoots(sandbox.docker.binds)).toEqual([path.join(dir, "B ")]);
  mockedExecDockerRaw.mockImplementation(async (args) => {
    if (getDockerScript(args).includes('readlink -n -f -- "$cursor"')) {
      return dockerExecResult(`${getDockerArg(args, 1)}\n`);
    }
    return dockerExecResult(getDockerArg(args, 1) === "readdir" ? "[]" : "");
  });
  await bridge.writeFile({ filePath: "/data /marker", data: "updated" });
  await bridge.readDirectory!({ filePath: "/data " });
  for (const operation of ["write", "readdir"]) {
    const call = mockedExecDockerRaw.mock.calls.find(
      ([args]) => getDockerArg(args, 1) === operation,
    );
    expect(call).toBeDefined();
    expect(getDockerArg(call![0], 2)).toBe("/data ");
    expect(getDockerArg(call![0], 3)).toBe("");
  }
  await expect(bridge.writeFile({ filePath: "/data/marker", data: "denied" })).rejects.toThrow(
    "read-only",
  );
});
