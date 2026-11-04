// Remote filesystem bridge tests cover SSH-style sandbox file operations using
// the pinned mutation helper and remote stat/path guards.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSandboxedReadTool, createSandboxedWriteTool } from "../agent-tools.read.js";
import { createCoreCodingTools } from "../core-coding-tools.js";
import { resolveSandboxFileMutationQueueKey } from "./file-mutation-identity.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./remote-fs-bridge.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function expectFile(filePath: string, content: string) {
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
}

function shellResult(stdout: string) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code: 0 };
}

function createStatRuntime(
  workspaceDir: string,
  outputs: { hardlinks: (script: string) => string; stat: (script: string) => string },
): RemoteShellSandboxHandle {
  return {
    remoteWorkspaceDir: workspaceDir,
    remoteAgentWorkspaceDir: workspaceDir,
    runRemoteShellScript: async (command) => {
      if (command.script.includes('if [ -e "$1" ] || [ -L "$1" ]')) {
        return shellResult("1\n");
      }
      if (command.script.includes('readlink -n -f -- "$cursor"')) {
        return shellResult(`${workspaceDir}/note.txt\0${workspaceDir}\0`);
      }
      if (command.script.includes('stat -c "%F|%h"')) {
        return shellResult(`${outputs.hardlinks(command.script)}\n`);
      }
      if (command.script.includes('stat -c "%F|%s|%y"')) {
        return shellResult(`${outputs.stat(command.script)}\n`);
      }
      throw new Error(`unexpected remote script: ${command.script}`);
    },
  };
}

function createLocalRemoteRuntime(
  params: string | { remoteWorkspaceDir: string; remoteAgentWorkspaceDir: string },
) {
  // Execute remote shell snippets locally so the bridge scripts are exercised
  // without a real SSH host.
  const calls: Array<Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]> = [];
  const roots =
    typeof params === "string"
      ? { remoteWorkspaceDir: params, remoteAgentWorkspaceDir: params }
      : params;
  const runtime: RemoteShellSandboxHandle = {
    ...roots,
    runRemoteShellScript: createLocalRemoteShellScriptRunner({
      onCommand: (command) => calls.push(command),
    }),
  };
  return { calls, runtime };
}

function createWorkspaceBridge(
  workspaceDir: string,
  runtime = createLocalRemoteRuntime(workspaceDir).runtime,
  overrides?: Parameters<typeof createSandbox>[0],
) {
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      ...overrides,
    }),
    runtime,
  });
}

async function createFixture(remote = false, overrides?: Parameters<typeof createSandbox>[0]) {
  const root = tempDirs.make("remote-fs-");
  const workspaceDir = path.join(root, "host");
  const remoteDir = remote ? path.join(root, "remote 'workspace'") : workspaceDir;
  for (const dir of new Set([workspaceDir, remoteDir])) {
    await fs.mkdir(dir);
  }
  const { runtime, calls } = createLocalRemoteRuntime(remoteDir);
  const at = (name: string) => path.join(remoteDir, name);
  const put = async (name: string, data: string | Buffer) => {
    await fs.mkdir(path.dirname(at(name)), { recursive: true });
    await fs.writeFile(at(name), data);
  };
  const contents = (name: string, data: string) => expectFile(at(name), data);
  return {
    root,
    workspaceDir,
    remoteDir,
    runtime,
    calls,
    at,
    put,
    contents,
    bridge: createWorkspaceBridge(workspaceDir, runtime, overrides),
  };
}

describe("remote pinned read sources", () => {
  it.runIf(process.platform !== "win32")(
    "keeps protected aliases outside workspace provenance",
    async () => {
      const workspaceDir = await fs.realpath(tempDirs.make("remote-protected-read-"));
      const protectedDir = path.join(workspaceDir, "protected");
      await fs.mkdir(protectedDir);
      await fs.writeFile(path.join(protectedDir, "USER.md"), "protected file");
      await fs.symlink(protectedDir, path.join(workspaceDir, "alias"), "dir");
      const { runtime } = createLocalRemoteRuntime(workspaceDir);
      const bridge = createWorkspaceBridge(workspaceDir, runtime, {
        readOnlyResourceMounts: [{ hostPath: protectedDir, containerPath: protectedDir }],
      });
      await expect(bridge.readFileWithSource!({ filePath: "alias/USER.md" })).resolves.toEqual({
        data: Buffer.from("protected file"),
        canonicalPath: path.join(protectedDir, "USER.md"),
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["alias", "canonical-parent"] as const)(
    "pins read provenance across a swapped %s",
    async (swap) => {
      const { workspaceDir, at, put } = await createFixture();
      const original = at("original");
      const replacement = at("replacement");
      const alias = at("alias");
      await put("original/MEMORY.md", "original bytes");
      await put("replacement/MEMORY.md", "replacement bytes");
      await fs.symlink(original, alias, "dir");
      const runRemoteShellScript = createLocalRemoteShellScriptRunner();
      let swapped = false;
      const bridge = createWorkspaceBridge(workspaceDir, {
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
        async runRemoteShellScript(command) {
          // Canonicalization has finished; the unmodified guest reader runs next.
          if (command.args?.[0] === "read" && !swapped) {
            swapped = true;
            if (swap === "alias") {
              await fs.unlink(alias);
              await fs.symlink(replacement, alias, "dir");
            } else {
              await fs.rename(original, path.join(workspaceDir, "moved-original"));
              await fs.symlink(replacement, original, "dir");
            }
          }
          return runRemoteShellScript(command);
        },
      });
      if (!bridge.readFileWithSource) {
        throw new Error("The remote bridge must preserve read provenance.");
      }
      const read = bridge.readFileWithSource({ filePath: "alias/MEMORY.md", maxBytes: 100 });
      if (swap === "alias") {
        await expect(read).resolves.toEqual({
          data: Buffer.from("original bytes"),
          canonicalPath: path.join(original, "MEMORY.md"),
          workspaceRelativePath: "original/MEMORY.md",
        });
      } else {
        await expect(read).rejects.toThrow(/not a directory|symbolic links|too many levels|ELOOP/i);
      }
      expect(swapped).toBe(true);
    },
  );
});

describe("remote sandbox fs bridge", () => {
  it.runIf(process.platform === "linux")(
    "streams file copies with the pinned mutation helper",
    async () => {
      const fixture = await createFixture();
      await fixture.put("source.txt", "streamed");
      const copyFile = fixture.bridge.copyFile?.bind(fixture.bridge);
      expect(copyFile).toBeTypeOf("function");
      await copyFile!({
        sourcePath: "source.txt",
        destinationPath: "nested/copy.txt",
      });
      await fixture.contents("nested/copy.txt", "streamed");
      expect(fixture.calls.some((call) => call.args?.[0] === "copy")).toBe(true);
    },
  );

  it.each([false, true])("resolves equal-root ownership (protected=%s)", (protectedRoot) => {
    const workspaceDir = path.resolve("mapping-workspace");
    const agentWorkspaceDir = path.resolve("mapping-agent");
    const resourceRoot = path.resolve("mapping-resource");
    const bridge = createRemoteShellSandboxFsBridge({
      sandbox: createSandbox({
        workspaceDir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
        readOnlyResourceMounts: protectedRoot
          ? [{ hostPath: resourceRoot, containerPath: "/runtime" }]
          : [],
      }),
      runtime: {
        remoteWorkspaceDir: "/runtime",
        remoteAgentWorkspaceDir: "/runtime",
        runRemoteShellScript: async () => {
          throw new Error("Path projection must not execute transport");
        },
      },
    });
    expect(bridge.pathMappings?.filter((mount) => mount.containerRoot === "/runtime")).toEqual([
      { hostRoot: protectedRoot ? resourceRoot : agentWorkspaceDir, containerRoot: "/runtime" },
    ]);
    expect(bridge.resolvePath({ filePath: "/runtime/note.txt" })).toEqual({
      containerPath: "/runtime/note.txt",
      relativePath: protectedRoot ? "note.txt" : "/runtime/note.txt",
    });
  });

  // This composition executes the bridge's GNU stat/readlink scripts locally.
  it.runIf(process.platform === "linux")(
    "reads a remote-only agent root but denies ls",
    async () => {
      const {
        root,
        workspaceDir,
        remoteDir: remoteWorkspaceDir,
        runtime,
        calls,
      } = await createFixture(true);
      const agentWorkspaceDir = path.join(root, "local-agent");
      const remoteAgentWorkspaceDir = path.join(root, "remote-agent");
      await fs.mkdir(remoteAgentWorkspaceDir);
      await fs.writeFile(path.join(remoteAgentWorkspaceDir, "note.txt"), "REMOTE_AGENT_MARKER");
      runtime.remoteAgentWorkspaceDir = remoteAgentWorkspaceDir;
      const sandbox = createSandbox({
        workspaceDir,
        agentWorkspaceDir,
        workspaceAccess: "ro",
        containerWorkdir: remoteWorkspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({ sandbox, runtime });
      sandbox.fsBridge = bridge;
      const tools = createCoreCodingTools({
        codingRoot: workspaceDir,
        containmentRoot: workspaceDir,
        includeBaseCodingTools: true,
        shellTools: "disabled",
        workspaceOnly: true,
        readOnly: false,
        sandbox,
        applyPatchEnabled: false,
        applyPatchWorkspaceOnly: true,
        execDefaults: {},
        processDefaults: {},
      });
      const target = path.join(remoteAgentWorkspaceDir, "note.txt");
      expect(bridge.resolvePath({ filePath: target }).hostPath).toBeUndefined();
      const read = tools.find((tool) => tool.name === "read")!;
      expect(
        JSON.stringify((await read.execute("read-agent", { path: target })).content),
      ).toContain("REMOTE_AGENT_MARKER");
      const before = calls.length;
      await expect(
        tools
          .find((tool) => tool.name === "ls")!
          .execute("deny-agent", { path: remoteAgentWorkspaceDir }),
      ).rejects.toThrow("Path escapes sandbox root");
      expect(calls).toHaveLength(before);
      expect(await fs.readFile(target, "utf8")).toBe("REMOTE_AGENT_MARKER");
    },
  );

  it.runIf(process.platform !== "win32").each([
    { workspaceAccess: "rw", mutation: "write" },
    { workspaceAccess: "ro", mutation: "write" },
    { workspaceAccess: "rw", mutation: "remove" },
    { workspaceAccess: "none", mutation: "rename" },
  ] as const)(
    "guards $workspaceAccess workspace and skill $mutation",
    async ({ workspaceAccess, mutation }) => {
      const {
        workspaceDir,
        remoteDir: remoteWorkspaceDir,
        bridge,
      } = await createFixture(true, { workspaceAccess });
      const filePath = "quoted ' \" $() `literal`.bin";
      const payload = Buffer.from([0, 255, 128, 10, 13, 39, 34, 36, 96]);
      const createFileExclusive = bridge.createFileExclusive!.bind(bridge);
      if (!bridge.readDirectory) {
        throw new Error("The remote bridge must support directory discovery.");
      }
      await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([]);
      await expect(bridge.readDirectory({ filePath: "../" })).rejects.toThrow();
      if (workspaceAccess === "ro") {
        await expect(createFileExclusive({ filePath, data: payload })).rejects.toThrow("read-only");
        await expect(fs.readdir(remoteWorkspaceDir)).resolves.toEqual([]);
        return;
      }
      await expect(createFileExclusive({ filePath, data: payload })).resolves.toBe("created");
      await expect(bridge.readFile({ filePath })).resolves.toEqual(payload);
      await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([
        { name: filePath, isDirectory: false },
      ]);
      await expect(createFileExclusive({ filePath, data: Buffer.alloc(1_048_576) })).resolves.toBe(
        "exists",
      );
      await expect(fs.readFile(path.join(remoteWorkspaceDir, filePath))).resolves.toEqual(payload);

      await bridge.writeFile({ filePath: "empty.txt", data: Buffer.alloc(0) });
      await expect(fs.readFile(path.join(remoteWorkspaceDir, "empty.txt"))).resolves.toEqual(
        Buffer.alloc(0),
      );
      await expect(bridge.readFile({ filePath: "empty.txt", maxBytes: 0 })).resolves.toEqual(
        Buffer.alloc(0),
      );
      await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
      const skillRelativePath =
        mutation === "write" ? "skills/demo/SKILL.md" : ".agents/skills/demo/SKILL.md";
      const skillPath = path.join(remoteWorkspaceDir, skillRelativePath);
      await fs.mkdir(path.dirname(skillPath), { recursive: true });
      await fs.writeFile(skillPath, "managed instructions");
      const mutate =
        mutation === "write"
          ? bridge.writeFile({ filePath: skillRelativePath, data: "changed" })
          : mutation === "remove"
            ? bridge.remove({ filePath: ".agents", recursive: true })
            : bridge.rename({ from: ".agents", to: "moved-instructions" });
      await expect(mutate).rejects.toThrow("read-only");
      await expectFile(skillPath, "managed instructions");
    },
  );

  it.each([
    [
      "1",
      "9007199254740992",
      "8640000000001",
      { type: "file", size: Number.MAX_SAFE_INTEGER, mtimeMs: 0 },
    ],
    ["0x2", "12", "2026-05-29 12:00:00.000000000 +0000", { type: "file", size: 12 }],
    ["2", "12", "2026-05-29 12:00:00.000000000 +0000", null],
  ] as const)(
    "parses C-locale stat output with link count %s",
    async (links, size, mtime, expected) => {
      const workspaceDir = tempDirs.make("remote-stat-");
      const kind = (script: string) =>
        script.includes("LC_ALL=C stat") ? "regular file" : "reguläre Datei";
      const bridge = createWorkspaceBridge(
        workspaceDir,
        createStatRuntime(workspaceDir, {
          hardlinks: (script) => `${kind(script)}|${links}`,
          stat: (script) => `${kind(script)}|${size}|${mtime}`,
        }),
      );
      const result = bridge.stat({ filePath: "note.txt" });
      if (!expected) {
        await expect(result).rejects.toThrow(/Hardlinked path/);
      } else if (links === "1") {
        await expect(result).resolves.toEqual(expected);
      } else {
        await expect(result).resolves.toMatchObject(expected);
      }
    },
  );
});

// These fixtures execute remote GNU stat/readlink and the Python launcher
// locally. Portable Python behavior stays in fs-bridge-mutation-helper.test.ts.
describe.runIf(process.platform === "linux")("remote sandbox fs bridge (GNU shell)", () => {
  it("orders sandbox tools through one remote alias identity", async () => {
    const {
      workspaceDir,
      remoteDir: remoteWorkspaceDir,
      bridge,
      runtime,
    } = await createFixture(true);
    const remotePath = path.join(remoteWorkspaceDir, "race-target.txt");
    const hostPath = path.join(workspaceDir, "race-target.txt");
    const aliasIdentity = await resolveSandboxFileMutationQueueKey({
      bridge,
      root: workspaceDir,
      filePath: remotePath,
      cwd: workspaceDir,
    });
    await expect(
      resolveSandboxFileMutationQueueKey({
        bridge,
        root: workspaceDir,
        filePath: hostPath,
        cwd: workspaceDir,
      }),
    ).resolves.toBe(aliasIdentity);
    const writeIdentityStarted = createDeferred();
    const releaseWriteIdentity = createDeferred();
    const readIdentityResolved = createDeferred();
    const runRemoteShellScript = runtime.runRemoteShellScript.bind(runtime);
    let identityCallCount = 0;
    runtime.runRemoteShellScript = async (command) => {
      const isTargetIdentity =
        command.script.includes('target="$1"') && command.args?.[0] === remotePath;
      if (!isTargetIdentity) {
        return await runRemoteShellScript(command);
      }
      const identityCall = ++identityCallCount;
      if (identityCall === 1) {
        writeIdentityStarted.resolve();
        await releaseWriteIdentity.promise;
      }
      const result = await runRemoteShellScript(command);
      if (identityCall === 2) {
        readIdentityResolved.resolve();
      }
      return result;
    };
    const statSpy = vi.spyOn(bridge, "stat");
    const writeTool = createSandboxedWriteTool({ root: workspaceDir, bridge });
    const readTool = createSandboxedReadTool({ root: workspaceDir, bridge });
    const writeResult = writeTool.execute("write", {
      path: remotePath,
      content: "remote snapshot",
    });
    await writeIdentityStarted.promise;
    const readResult = readTool.execute("read", { path: hostPath });
    void readResult.catch(() => {});
    await readIdentityResolved.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(statSpy).not.toHaveBeenCalled();

    releaseWriteIdentity.resolve();
    const [, result] = await Promise.all([writeResult, readResult]);
    expect(statSpy).toHaveBeenCalled();
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "remote snapshot" })]),
    );
  });

  it("settles concurrent exclusive creates with one winner", async () => {
    const { workspaceDir, bridge } = await createFixture();
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    const outcomes = await Promise.all([
      createFileExclusive!({ filePath: "nested/race.txt", data: "one" }),
      createFileExclusive!({ filePath: "nested/race.txt", data: "two" }),
    ]);
    expect(outcomes.toSorted()).toEqual(["created", "exists"]);
    await expect(fs.readFile(path.join(workspaceDir, "nested/race.txt"), "utf8")).resolves.toMatch(
      /^(one|two)$/u,
    );
  });

  it("preserves symlink targets on exclusive creation", async () => {
    const { at, put, contents, bridge } = await createFixture();
    await put("target.txt", "keep");
    await fs.symlink("target.txt", at("link.txt"));
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");
    await expect(
      createFileExclusive!({ filePath: "link.txt", data: Buffer.alloc(1_048_576) }),
    ).resolves.toBe("exists");
    await contents("target.txt", "keep");
  });

  it("forwards and enforces bounded pinned file reads", async () => {
    const { workspaceDir, bridge, put, calls } = await createFixture();
    await put("..note.txt", "hello");
    await expect(bridge.readFile({ filePath: "." })).rejects.toThrow(
      /Invalid sandbox entry target/,
    );
    expect(calls).toHaveLength(0);
    expect(bridge.resolvePath({ filePath: "..note.txt" })).toMatchObject({
      relativePath: "..note.txt",
      containerPath: `${workspaceDir}/..note.txt`,
    });
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: 5 })).resolves.toEqual(
      Buffer.from("hello"),
    );
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: 4 })).rejects.toMatchObject({
      code: "too-large",
      message: expect.stringContaining("bounded read limit"),
    });
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: -1 })).rejects.toThrow(
      /non-negative safe integer/i,
    );
  });

  it("rejects symlink escapes while reading", async () => {
    // The remote helper uses no-follow file opens; symlinked final components
    // must fail even when the local caller cannot inspect the remote inode.
    const stateDir = tempDirs.make("openclaw-remote-fs-bridge-");
    const workspaceDir = path.join(stateDir, "workspace");
    const outsideDir = path.join(stateDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified", "utf8");
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(workspaceDir, "link.txt"));
    const bridge = createWorkspaceBridge(workspaceDir);
    await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
      /symbolic links|too many levels|ELOOP/i,
    );
  });

  it("pins mutations through a symlinked workspace root", async () => {
    const root = tempDirs.make("remote-fs-pinned-");
    const host = path.join(root, "host");
    const physical = path.join(root, "physical");
    const logical = path.join(root, "logical");
    const real = path.join(physical, "real");
    const decoy = path.join(physical, "decoy");
    await fs.mkdir(host);
    await fs.mkdir(real, { recursive: true });
    await fs.mkdir(decoy);
    await fs.symlink(physical, logical);
    const bridge = createWorkspaceBridge(host, createLocalRemoteRuntime(logical).runtime);
    const alias = path.join(logical, "alias");
    await fs.symlink(real, alias);
    const pin = async (
      filePath: string,
      action: "write" | "remove" | "mkdir",
      policyPath: string,
      pinnedPath: string,
    ) => {
      const target = await bridge.resolvePinnedMutationTarget!({ filePath, action });
      expect(target).toEqual({ policyPath, pinnedPath });
      return { filePath, pinnedPath: target.pinnedPath };
    };
    await pin("note.txt", "write", path.join(logical, "note.txt"), path.join(physical, "note.txt"));
    const target = await pin(
      "alias/note.txt",
      "write",
      path.join(logical, "real/note.txt"),
      path.join(real, "note.txt"),
    );
    await fs.unlink(alias);
    await fs.symlink(decoy, alias);
    await bridge.writeFile({ ...target, data: "after-swap" });
    await expectFile(path.join(real, "note.txt"), "after-swap");
    await expect(fs.stat(path.join(decoy, "note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.unlink(alias);
    await fs.symlink(real, alias);
    await fs.writeFile(path.join(real, "gone.txt"), "remove-me");
    await fs.writeFile(path.join(real, "keep.txt"), "keep-me");
    await bridge.remove({
      ...(await pin(
        "alias/gone.txt",
        "remove",
        path.join(logical, "real/gone.txt"),
        path.join(real, "gone.txt"),
      )),
      force: true,
    });
    await expect(fs.stat(path.join(real, "gone.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectFile(path.join(real, "keep.txt"), "keep-me");
    await bridge.mkdirp(
      await pin(
        "alias/newdir",
        "mkdir",
        path.join(logical, "real/newdir"),
        path.join(real, "newdir"),
      ),
    );
    expect((await fs.stat(path.join(real, "newdir"))).isDirectory()).toBe(true);
    await bridge.mkdirp(await pin(".", "mkdir", logical, physical));
  });
});

it.runIf(process.platform === "linux").each(["remove", "rename"] as const)(
  "%s pins parent aliases without following final symlinks",
  async (operation) => {
    const stateDir = await fs.realpath(tempDirs.make("remote-parent-alias-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const realDir = path.join(workspaceDir, "real");
    const outsideDir = path.join(stateDir, "outside");
    await fs.mkdir(realDir, { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.symlink(realDir, path.join(workspaceDir, "alias"), "dir");
    await fs.symlink(outsideDir, path.join(workspaceDir, "escape"), "dir");
    const bridge = createWorkspaceBridge(workspaceDir);
    const mutate = (from: string, to: string) =>
      operation === "remove"
        ? bridge.remove({ filePath: from, force: false })
        : bridge.rename({ from, to });
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "root sentinel");
    await fs.writeFile(path.join(realDir, "note.txt"), "requested bytes");
    await mutate("alias/note.txt", "moved.txt");
    await expectFile(path.join(workspaceDir, "note.txt"), "root sentinel");
    await expect(fs.lstat(path.join(realDir, "note.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (operation === "rename") {
      await expectFile(path.join(workspaceDir, "moved.txt"), "requested bytes");
    }
    const linkTarget = path.join(outsideDir, "target.txt");
    await fs.writeFile(linkTarget, "outside target");
    await fs.writeFile(path.join(workspaceDir, "link.txt"), "root link sentinel");
    await fs.symlink(linkTarget, path.join(realDir, "link.txt"));
    await mutate("alias/link.txt", "moved-link.txt");
    await expectFile(path.join(workspaceDir, "link.txt"), "root link sentinel");
    await expect(fs.lstat(path.join(realDir, "link.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectFile(linkTarget, "outside target");
    if (operation === "rename") {
      await expect(fs.readlink(path.join(workspaceDir, "moved-link.txt"))).resolves.toBe(
        linkTarget,
      );
    }
    await fs.writeFile(path.join(workspaceDir, "escape-target.txt"), "root escape sentinel");
    await fs.writeFile(path.join(outsideDir, "escape-target.txt"), "outside sentinel");
    await expect(mutate("escape/escape-target.txt", "escaped.txt")).rejects.toThrow(
      "escapes allowed mounts",
    );
    await expectFile(path.join(workspaceDir, "escape-target.txt"), "root escape sentinel");
    await expectFile(path.join(outsideDir, "escape-target.txt"), "outside sentinel");
  },
);

it.runIf(process.platform !== "win32")(
  "preserves newline bytes in roots and parent paths",
  async () => {
    const workspaceDir = path.join(
      await fs.realpath(tempDirs.make("remote-path-bytes-")),
      "root\n",
    );
    await fs.mkdir(path.join(workspaceDir, "existing\n"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "existing\n", "note.txt"), "original");
    const bridge = createWorkspaceBridge(workspaceDir);
    const absentPath = path.join(workspaceDir, "absent");
    for (const filePath of [absentPath, `${absentPath}/`]) {
      await expect(
        resolveSandboxFileMutationQueueKey({ bridge, root: workspaceDir, filePath }),
      ).resolves.toBe(`${workspaceDir}\0${absentPath}`);
    }
    await expect(bridge.readFileWithSource!({ filePath: "existing\n/note.txt" })).resolves.toEqual({
      data: Buffer.from("original"),
      canonicalPath: path.join(workspaceDir, "existing\n", "note.txt"),
      workspaceRelativePath: "existing\n/note.txt",
    });
    const destination = await bridge.resolvePinnedMutationTarget!({
      filePath: "new\n/note.txt",
      action: "write",
    });
    expect(destination).toEqual({
      policyPath: path.join(workspaceDir, "new\n", "note.txt"),
      pinnedPath: path.join(workspaceDir, "new\n", "note.txt"),
    });
    await bridge.writeFile({
      filePath: "new\n/note.txt",
      data: "created",
      pinnedPath: destination.pinnedPath,
    });
    await expectFile(path.join(workspaceDir, "new\n", "note.txt"), "created");
  },
);
