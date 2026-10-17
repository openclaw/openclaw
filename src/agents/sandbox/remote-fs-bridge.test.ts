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
  remoteWorkspaceDir: string,
  remoteAgentWorkspaceDir = remoteWorkspaceDir,
) {
  const calls: Array<Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]> = [];
  const runtime: RemoteShellSandboxHandle = {
    remoteWorkspaceDir,
    remoteAgentWorkspaceDir,
    runRemoteShellScript: createLocalRemoteShellScriptRunner({
      onCommand: (command) => calls.push(command),
    }),
  };
  return { calls, runtime };
}

function createWorkspaceBridge(
  workspaceDir: string,
  runtime = createLocalRemoteRuntime(workspaceDir).runtime,
  options: Partial<Parameters<typeof createSandbox>[0]> = {},
) {
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir, ...options }),
    runtime,
  });
}

async function expectText(file: string, text: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(text);
}

async function expectMissing(file: string) {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function makeDirectories(...directories: string[]) {
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true });
  }
}

async function createFixture(
  separateRemote = false,
  options: Partial<Parameters<typeof createSandbox>[0]> = {},
) {
  const root = await fs.realpath(tempDirs.make("remote-fs-"));
  const workspaceDir = path.join(root, "workspace");
  const remoteWorkspaceDir = separateRemote ? path.join(root, "remote 'workspace'") : workspaceDir;
  await makeDirectories(workspaceDir, remoteWorkspaceDir);
  const { calls, runtime } = createLocalRemoteRuntime(remoteWorkspaceDir);
  const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir, ...options });
  const bridge = createRemoteShellSandboxFsBridge({ sandbox, runtime });
  const file = (...parts: string[]) => path.join(remoteWorkspaceDir, ...parts);
  return { root, workspaceDir, remoteWorkspaceDir, calls, runtime, sandbox, bridge, file };
}

describe("remote pinned read sources", () => {
  it.runIf(process.platform !== "win32")(
    "does not classify a parent alias into a protected mount as workspace memory",
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
    "keeps read provenance bound to the bytes when the %s is swapped",
    async (swap) => {
      const workspaceDir = await fs.realpath(tempDirs.make("openclaw-remote-read-source-"));
      const original = path.join(workspaceDir, "original");
      const replacement = path.join(workspaceDir, "replacement");
      const alias = path.join(workspaceDir, "alias");
      await makeDirectories(original, replacement);
      await fs.writeFile(path.join(original, "MEMORY.md"), "original bytes");
      await fs.writeFile(path.join(replacement, "MEMORY.md"), "replacement bytes");
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
      const read = bridge.readFileWithSource!({ filePath: "alias/MEMORY.md", maxBytes: 100 });
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
  it.each([false, true])(
    "keeps equal-root descriptor and resolver ownership aligned with protected=%s",
    (protectedRoot) => {
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
    },
  );

  it.runIf(process.platform === "linux")(
    "admits the backend's nondefault agent root without a local host path",
    async () => {
      const root = await fs.realpath(tempDirs.make("remote-mapping-"));
      const workspaceDir = path.join(root, "local-workspace");
      const agentWorkspaceDir = path.join(root, "local-agent");
      const remoteWorkspaceDir = path.join(root, "remote-workspace");
      const remoteAgentWorkspaceDir = path.join(root, "remote-agent");
      await makeDirectories(
        workspaceDir,
        agentWorkspaceDir,
        remoteWorkspaceDir,
        remoteAgentWorkspaceDir,
      );
      await fs.writeFile(path.join(remoteAgentWorkspaceDir, "note.txt"), "REMOTE_AGENT_MARKER");
      const { calls, runtime } = createLocalRemoteRuntime(
        remoteWorkspaceDir,
        remoteAgentWorkspaceDir,
      );
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
    "enforces $workspaceAccess workspace writes and protects remote-only skills from $mutation",
    async ({ workspaceAccess, mutation }) => {
      const { workspaceDir, remoteWorkspaceDir, bridge } = await createFixture(true, {
        workspaceAccess,
      });
      const filePath = "quoted ' \" $() `literal`.bin";
      const payload = Buffer.from([0, 255, 128, 10, 13, 39, 34, 36, 96]);
      const createFileExclusive = bridge.createFileExclusive!.bind(bridge);
      await expect(bridge.readDirectory!({ filePath: "." })).resolves.toEqual([]);
      await expect(bridge.readDirectory!({ filePath: "../" })).rejects.toThrow();
      if (workspaceAccess === "ro") {
        await expect(createFileExclusive({ filePath, data: payload })).rejects.toThrow("read-only");
        await expect(fs.readdir(remoteWorkspaceDir)).resolves.toEqual([]);
        return;
      }

      await expect(createFileExclusive({ filePath, data: payload })).resolves.toBe("created");
      await expect(bridge.readFile({ filePath })).resolves.toEqual(payload);
      await expect(bridge.readDirectory!({ filePath: "." })).resolves.toEqual([
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
      await expectText(skillPath, "managed instructions");
    },
  );

  it("rejects mount-root reads before invoking the mutation helper", async () => {
    const { calls, bridge } = await createFixture();
    await expect(bridge.readFile({ filePath: "." })).rejects.toThrow(
      /Invalid sandbox entry target/,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      name: "normalizes stat output locale and saturates unsafe sizes",
      hardlinks: () => "regular file|1",
      stat: (script: string) =>
        `${script.includes('LC_ALL=C stat -c "%F|%s|%y"') ? "regular file" : "reguläre Datei"}|9007199254740992|8640000000001`,
      expected: { type: "file", size: Number.MAX_SAFE_INTEGER, mtimeMs: 0 },
    },
    {
      name: "rejects hardlinked files under localized remote shells",
      hardlinks: (script: string) =>
        `${script.includes('LC_ALL=C stat -c "%F|%h"') ? "regular file" : "reguläre Datei"}|2`,
      stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      expected: /Hardlinked path/,
    },
    {
      name: "does not reject malformed non-decimal hardlink counts",
      hardlinks: () => "regular file|0x2",
      stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      expected: { type: "file", size: 12 },
    },
  ])("$name", async ({ hardlinks, stat, expected }) => {
    const workspaceDir = path.resolve("workspace");
    const bridge = createWorkspaceBridge(
      workspaceDir,
      createStatRuntime(workspaceDir, { hardlinks, stat }),
    );
    const result = bridge.stat({ filePath: "note.txt" });
    if (expected instanceof RegExp) {
      await expect(result).rejects.toThrow(expected);
    } else if ("mtimeMs" in expected) {
      await expect(result).resolves.toEqual(expected);
    } else {
      await expect(result).resolves.toMatchObject(expected);
    }
  });
});

describe.runIf(process.platform === "linux")("remote sandbox fs bridge (GNU shell)", () => {
  it("orders sandbox tools through one remote alias identity", async () => {
    const { workspaceDir, remoteWorkspaceDir, runtime, bridge } = await createFixture(true);
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

  it("creates files exclusively and preserves existing entries", async () => {
    const { bridge, file } = await createFixture();
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");

    await expect(
      createFileExclusive!({ filePath: "nested/note.txt", data: "first" }),
    ).resolves.toBe("created");
    await expect(
      createFileExclusive!({ filePath: "nested/note.txt", data: "replacement" }),
    ).resolves.toBe("exists");
    await expectText(file("nested", "note.txt"), "first");

    const outcomes = await Promise.all([
      createFileExclusive!({ filePath: "race.txt", data: "one" }),
      createFileExclusive!({ filePath: "race.txt", data: "two" }),
    ]);
    expect(outcomes.toSorted()).toEqual(["created", "exists"]);
    await expect(fs.readFile(file("race.txt"), "utf8")).resolves.toMatch(/^(one|two)$/u);
  });

  it("treats a symlink destination as existing without changing its target", async () => {
    const { bridge, file } = await createFixture();
    await fs.writeFile(file("target.txt"), "keep", "utf8");
    await fs.symlink("target.txt", file("link.txt"));
    const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
    expect(createFileExclusive).toBeTypeOf("function");

    await expect(
      createFileExclusive!({ filePath: "link.txt", data: Buffer.alloc(1_048_576) }),
    ).resolves.toBe("exists");
    await expectText(file("target.txt"), "keep");
  });

  it("forwards and enforces bounded pinned file reads", async () => {
    const { workspaceDir, calls, bridge, file } = await createFixture();
    await fs.writeFile(file("..note.txt"), "hello", "utf8");
    expect(bridge.resolvePath({ filePath: "..note.txt" })).toMatchObject({
      relativePath: "..note.txt",
      containerPath: `${workspaceDir}/..note.txt`,
    });
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: 5 })).resolves.toEqual(
      Buffer.from("hello"),
    );
    expect(calls.find((call) => call.args?.[0] === "read")?.args).toEqual([
      "read",
      workspaceDir,
      "",
      "..note.txt",
      "5",
    ]);
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: 4 })).rejects.toThrow(
      /bounded read limit/i,
    );
    await expect(bridge.readFile({ filePath: "..note.txt", maxBytes: -1 })).rejects.toThrow(
      /non-negative safe integer/i,
    );
    expect(calls).toHaveLength(4);
  });

  it("streams file copies with the pinned mutation helper", async () => {
    const { calls, bridge, file } = await createFixture();
    await fs.writeFile(file("source.txt"), "streamed", "utf8");
    const copyFile = bridge.copyFile?.bind(bridge);
    expect(copyFile).toBeTypeOf("function");
    await copyFile!({
      sourcePath: "source.txt",
      destinationPath: "nested/copy.txt",
    });

    await expectText(file("nested", "copy.txt"), "streamed");
    expect(calls.some((call) => call.args?.[0] === "copy")).toBe(true);
  });

  it("rejects symlink escapes while reading", async () => {
    const { root, bridge, file } = await createFixture();
    const outsideDir = path.join(root, "outside");
    await makeDirectories(outsideDir);
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified", "utf8");
    await fs.symlink(path.join(outsideDir, "secret.txt"), file("link.txt"));
    await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
      /symbolic links|too many levels|ELOOP/i,
    );
  });

  it.runIf(process.platform !== "win32")(
    "authorizes logical policy paths and pins physical canonical destinations with observed final effects",
    async () => {
      const root = await fs.realpath(tempDirs.make("remote-pinned-"));
      const hostWorkspaceDir = path.join(root, "host-workspace");
      const realWorkspaceDir = path.join(root, "real-workspace");
      const linkedWorkspaceDir = path.join(root, "linked-workspace");
      await makeDirectories(hostWorkspaceDir, realWorkspaceDir);
      // Policy grants use the logical alias; mutation pins use the physical root.
      await fs.symlink(realWorkspaceDir, linkedWorkspaceDir);
      const { runtime } = createLocalRemoteRuntime(linkedWorkspaceDir);
      const bridge = createWorkspaceBridge(hostWorkspaceDir, runtime);
      const pin = async (
        filePath: string,
        action: "write" | "remove" | "mkdir",
        policy: string,
        physical: string,
      ) => {
        const target = await bridge.resolvePinnedMutationTarget!({ filePath, action });
        expect(target).toEqual({ policyPath: policy, pinnedPath: physical });
        return target.pinnedPath;
      };
      const logical = (...parts: string[]) => path.join(linkedWorkspaceDir, ...parts);
      const physical = (...parts: string[]) => path.join(realWorkspaceDir, ...parts);

      const realDir = physical("real");
      const decoyDir = physical("decoy");
      await makeDirectories(realDir, decoyDir);
      await fs.symlink(realDir, logical("alias"));
      await fs.writeFile(logical("source.txt"), "copy-source");

      const writePin = await pin("note.txt", "write", logical("note.txt"), physical("note.txt"));
      await bridge.writeFile({
        filePath: "note.txt",
        data: "pinned",
        pinnedPath: writePin,
      });
      await expectText(physical("note.txt"), "pinned");

      // Post-authorization alias swap: the pinned write cannot be redirected.
      const aliasTarget = await bridge.resolvePinnedMutationTarget!({
        filePath: "alias/note.txt",
        action: "write",
      });
      expect(aliasTarget.pinnedPath).toBe(path.join(realDir, "note.txt"));
      await fs.unlink(logical("alias"));
      await fs.symlink(decoyDir, logical("alias"));
      await bridge.writeFile({
        filePath: "alias/note.txt",
        data: "after-swap",
        pinnedPath: aliasTarget.pinnedPath,
      });
      await expectText(path.join(realDir, "note.txt"), "after-swap");
      await expectMissing(path.join(decoyDir, "note.txt"));

      await fs.unlink(logical("alias"));
      await fs.symlink(realDir, logical("alias"));
      await fs.writeFile(path.join(realDir, "gone.txt"), "remove-me");
      await fs.writeFile(path.join(realDir, "keep.txt"), "keep-me");
      const removeTarget = await bridge.resolvePinnedMutationTarget!({
        filePath: "alias/gone.txt",
        action: "remove",
      });
      expect(removeTarget.pinnedPath).toBe(path.join(realDir, "gone.txt"));
      await bridge.remove({
        filePath: "alias/gone.txt",
        force: true,
        pinnedPath: removeTarget.pinnedPath,
      });
      await expectMissing(path.join(realDir, "gone.txt"));
      await expectText(path.join(realDir, "keep.txt"), "keep-me");

      const directoryPin = await pin(
        "alias/newdir",
        "mkdir",
        logical("real/newdir"),
        physical("real/newdir"),
      );
      await bridge.mkdirp({ filePath: "alias/newdir", pinnedPath: directoryPin });
      expect((await fs.stat(physical("real/newdir"))).isDirectory()).toBe(true);

      const rootPin = await pin(".", "mkdir", linkedWorkspaceDir, realWorkspaceDir);
      await bridge.mkdirp({ filePath: ".", pinnedPath: rootPin });
    },
  );
});

it.runIf(process.platform === "linux").each(["remove", "rename"] as const)(
  "%s resolves the parent alias without changing sibling files or following the final symlink",
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
    await expectText(path.join(workspaceDir, "note.txt"), "root sentinel");
    await expectMissing(path.join(realDir, "note.txt"));
    if (operation === "rename") {
      await expectText(path.join(workspaceDir, "moved.txt"), "requested bytes");
    }

    const linkTarget = path.join(outsideDir, "target.txt");
    await fs.writeFile(linkTarget, "outside target");
    await fs.writeFile(path.join(workspaceDir, "link.txt"), "root link sentinel");
    await fs.symlink(linkTarget, path.join(realDir, "link.txt"));
    await mutate("alias/link.txt", "moved-link.txt");
    await expectText(path.join(workspaceDir, "link.txt"), "root link sentinel");
    await expectMissing(path.join(realDir, "link.txt"));
    await expectText(linkTarget, "outside target");
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
    await expectText(path.join(workspaceDir, "escape-target.txt"), "root escape sentinel");
    await expectText(path.join(outsideDir, "escape-target.txt"), "outside sentinel");
  },
);

it.runIf(process.platform !== "win32")(
  "preserves newline bytes in remote mount roots, existing parents, and new parents",
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
    await expectText(path.join(workspaceDir, "new\n", "note.txt"), "created");
  },
);
