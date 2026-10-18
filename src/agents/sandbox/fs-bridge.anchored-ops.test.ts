// Anchored filesystem bridge tests cover pinned parent/basename operations that
// avoid path re-resolution inside Docker mutation commands.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import {
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  createSeededSandboxFsBridge,
  dockerExecResult,
  findCallsByScriptFragment,
  findCallByDockerArg,
  findCallByScriptFragment,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

type DockerRawCall = NonNullable<ReturnType<typeof findCallByDockerArg>>;

function requireDockerCall(call: DockerRawCall | undefined, label: string): DockerRawCall {
  if (!call) {
    throw new Error(`expected docker call for ${label}`);
  }
  return call;
}

describe("sandbox fs bridge anchored ops", () => {
  let readGate: ((fd: number) => Promise<void>) | undefined;
  installFsBridgeTestHarness({
    beforeAsyncRead: async (fd) => {
      await readGate?.(fd);
    },
  });

  it.each([
    { name: "uncapped", maxBytes: undefined },
    { name: "bounded", maxBytes: 5 },
  ])("yields during $name reads while retaining the opened file", async ({ maxBytes }) => {
    await withTempDir("openclaw-fs-bridge-async-read-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
      const openRootFile = mockedOpenRootFile.getMockImplementation();
      if (!openRootFile) {
        throw new Error("expected the real sandbox root-file opener");
      }
      const events: string[] = [];
      let heartbeat: Promise<void> | undefined;
      let openedFd: number | undefined;
      mockedOpenRootFile.mockImplementationOnce(async (params) => {
        const opened = await openRootFile(params);
        if (opened.ok) {
          openedFd = opened.fd;
          await fs.rename(
            path.join(workspaceDir, "from.txt"),
            path.join(workspaceDir, "pinned.txt"),
          );
          await fs.writeFile(path.join(workspaceDir, "from.txt"), "replacement");
          heartbeat = new Promise<void>((resolve) => {
            setImmediate(() => {
              events.push("event-loop");
              resolve();
            });
          });
        }
        return opened;
      });
      readGate = async (fd) => {
        expect(fd).toBe(openedFd);
        await heartbeat;
        expect(fsSync.fstatSync(fd).isFile()).toBe(true);
      };

      let contents: Buffer;
      try {
        contents = await bridge.readFile({ filePath: "from.txt", maxBytes });
        events.push("read-complete");
      } finally {
        await heartbeat;
        readGate = undefined;
      }
      expect(contents).toEqual(Buffer.from("hello"));
      expect(events).toEqual(["event-loop", "read-complete"]);
      const closedFd = openedFd;
      if (closedFd === undefined) {
        throw new Error("expected a pinned read descriptor");
      }
      expect(() => fsSync.fstatSync(closedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    });
  });

  it("reads files spanning bounded read chunks through one pinned descriptor", async () => {
    await withTempDir("openclaw-fs-bridge-bounded-read-", async (stateDir) => {
      const contents = "x".repeat(64 * 1024 + 1);
      const { bridge } = await createSeededSandboxFsBridge(stateDir, {
        rootContents: contents,
      });

      await expect(
        bridge.readFile({ filePath: "from.txt", maxBytes: contents.length }),
      ).resolves.toEqual(Buffer.from(contents));
      expect(mockedOpenRootFile).toHaveBeenCalledTimes(1);
      expectOnlyCanonicalPathCommands();
    });
  });

  it("rejects negative limits without an unbounded read", async () => {
    await withTempDir("openclaw-fs-bridge-bounded-reject-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir, {
        rootContents: "hello",
      });

      await expect(bridge.readFile({ filePath: "from.txt", maxBytes: -1 })).rejects.toThrow(
        /non-negative safe integer/,
      );
      expect(mockedOpenRootFile).toHaveBeenCalledTimes(1);
      expectOnlyCanonicalPathCommands();
    });
  });

  it("rejects files that grow after the sandbox descriptor is opened", async () => {
    await withTempDir("openclaw-fs-bridge-bounded-growth-", async (stateDir) => {
      const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir, {
        rootContents: "hello",
      });
      const openRootFile = mockedOpenRootFile.getMockImplementation();
      if (!openRootFile) {
        throw new Error("expected the real sandbox root-file opener");
      }
      mockedOpenRootFile.mockImplementationOnce(async (params) => {
        const opened = await openRootFile(params);
        if (opened.ok) {
          await fs.appendFile(path.join(workspaceDir, "from.txt"), "!");
        }
        return opened;
      });

      await expect(bridge.readFile({ filePath: "from.txt", maxBytes: 5 })).rejects.toThrow(
        /exceeds 5 bytes/,
      );
      expect(mockedOpenRootFile).toHaveBeenCalledTimes(1);
      expectOnlyCanonicalPathCommands();
    });
  });

  const pinnedCases = [
    {
      name: "exclusive create pins canonical parent + basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) => {
        const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
        if (!createFileExclusive) {
          throw new Error("expected exclusive-create capability");
        }
        return createFileExclusive({ filePath: "nested/new.txt", data: "created" });
      },
      expectedArgs: ["create", "/workspace", "nested", "new.txt", "1"],
      forbiddenArgs: ["/workspace/nested/new.txt"],
    },
    {
      name: "write pins canonical parent + basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.writeFile({ filePath: "nested/file.txt", data: "updated" }),
      expectedArgs: ["write", "/workspace", "nested", "file.txt", "1"],
      forbiddenArgs: ["/workspace/nested/file.txt"],
    },
    {
      name: "mkdirp pins mount root + relative path",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.mkdirp({ filePath: "nested/leaf" }),
      expectedArgs: ["mkdirp", "/workspace", "nested/leaf"],
      forbiddenArgs: ["/workspace/nested/leaf"],
    },
    {
      name: "remove pins mount root + parent/basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.remove({ filePath: "nested/file.txt" }),
      expectedArgs: ["remove", "/workspace", "nested", "file.txt", "0", "1"],
      forbiddenArgs: ["/workspace/nested/file.txt"],
    },
    {
      name: "rename pins both parents + basenames",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.rename({ from: "from.txt", to: "nested/to.txt" }),
      expectedArgs: ["rename", "/workspace", "", "from.txt", "/workspace", "nested", "to.txt", "1"],
      forbiddenArgs: ["/workspace/from.txt", "/workspace/nested/to.txt"],
    },
  ] as const;

  it.each(pinnedCases)("$name", async (testCase) => {
    // Mutations pass mount roots and basenames separately; full target paths
    // would allow symlink swaps between validation and execution.
    await withTempDir("openclaw-fs-bridge-contract-write-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await testCase.invoke(bridge);

      const opCall = mockedExecDockerRaw.mock.calls.find(
        ([args]) =>
          typeof args[5] === "string" &&
          args[5].includes('exec "$python_cmd" -c "$python_script" "$@"') &&
          getDockerArg(args, 1) === testCase.expectedArgs[0],
      );
      const args = requireDockerCall(opCall, testCase.name)[0];
      testCase.expectedArgs.forEach((value, index) => {
        expect(getDockerArg(args, index + 1)).toBe(value);
      });
      testCase.forbiddenArgs.forEach((value) => {
        expect(args).not.toContain(value);
      });
    });
  });

  it("allows dot-dot-prefixed sandbox entries without treating them as parent traversal", async () => {
    await withTempDir("openclaw-fs-bridge-dot-prefix-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      expect(bridge.resolvePath({ filePath: "..cache" })).toMatchObject({
        relativePath: "..cache",
        containerPath: "/workspace/..cache",
      });
      await bridge.mkdirp({ filePath: "..cache" });

      const mkdirCall = requireDockerCall(findCallByDockerArg(1, "mkdirp"), "mkdirp");
      expect(getDockerArg(mkdirCall[0], 2)).toBe("/workspace");
      expect(getDockerArg(mkdirCall[0], 3)).toBe("..cache");
    });
  });

  it.runIf(process.platform !== "win32")(
    "write resolves directory aliases to canonical pinned paths",
    async () => {
      // Parent symlinks are resolved once to a canonical path, then the write is
      // anchored there so later alias changes cannot redirect the target.
      await withTempDir("openclaw-fs-bridge-contract-write-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const realDir = path.join(workspaceDir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, path.join(workspaceDir, "alias"));

        mockedExecDockerRaw.mockImplementation(async (args) => {
          const script = getDockerScript(args);
          if (script.includes('readlink -n -f -- "$cursor"')) {
            const target = getDockerArg(args, 1);
            return dockerExecResult(`${target.replace("/workspace/alias", "/workspace/real")}\n`);
          }
          return dockerExecResult("");
        });

        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
          }),
        });

        await bridge.writeFile({ filePath: "alias/note.txt", data: "updated" });

        const args = requireDockerCall(findCallByDockerArg(1, "write"), "write")[0];
        expect(getDockerArg(args, 2)).toBe("/workspace");
        expect(getDockerArg(args, 3)).toBe("real");
        expect(getDockerArg(args, 4)).toBe("note.txt");
        expect(args).not.toContain("alias");

        const canonicalCalls = findCallsByScriptFragment('readlink -n -f -- "$cursor"');
        expect(
          canonicalCalls.some(([callArgs]) => getDockerArg(callArgs, 1) === "/workspace/alias"),
        ).toBe(true);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "resolvePinnedMutationTarget canonicalizes symlinked parents",
    async () => {
      await withTempDir("openclaw-fs-bridge-pinned-target-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const realDir = path.join(workspaceDir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, path.join(workspaceDir, "alias"));

        mockedExecDockerRaw.mockImplementation(async (args) => {
          const script = getDockerScript(args);
          if (script.includes('readlink -n -f -- "$cursor"')) {
            const target = getDockerArg(args, 1);
            return dockerExecResult(`${target.replace("/workspace/alias", "/workspace/real")}\n`);
          }
          return dockerExecResult("");
        });

        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });

        await expect(
          bridge.resolvePinnedMutationTarget!({ filePath: "alias/note.txt", action: "write" }),
        ).resolves.toEqual({
          policyPath: "/workspace/real/note.txt",
          pinnedPath: "/workspace/real/note.txt",
        });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "writeFile pins an authorized canonical destination without re-resolving aliases",
    async () => {
      await withTempDir("openclaw-fs-bridge-pinned-write-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const realDir = path.join(workspaceDir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, path.join(workspaceDir, "alias"));

        mockedExecDockerRaw.mockImplementation(async (args) => {
          const script = getDockerScript(args);
          if (script.includes('readlink -n -f -- "$cursor"')) {
            // Simulates an attacker swap: any re-canonicalization through the
            // alias after authorization would redirect the pin into .git.
            const target = getDockerArg(args, 1);
            return dockerExecResult(`${target.replace("/workspace/real", "/workspace/.git")}\n`);
          }
          if (script.includes('stat -c "%F|%s|%y"')) {
            return dockerExecResult("regular file|1|2");
          }
          return dockerExecResult("");
        });

        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        });

        await bridge.writeFile({
          filePath: "alias/note.txt",
          data: "updated",
          pinnedPath: "/workspace/real/note.txt",
        });

        const writeArgs = requireDockerCall(findCallByDockerArg(1, "write"), "write")[0];
        expect(getDockerArg(writeArgs, 2)).toBe("/workspace");
        expect(getDockerArg(writeArgs, 3)).toBe("real");
        expect(getDockerArg(writeArgs, 4)).toBe("note.txt");
        expect(writeArgs).not.toContain("/workspace/.git");
      });
    },
  );

  it("rejects pinned destinations that do not match the requested basename", async () => {
    await withTempDir("openclaw-fs-bridge-pinned-mismatch-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await expect(
        bridge.writeFile({
          filePath: "notes/todo.txt",
          data: "updated",
          pinnedPath: "/workspace/notes/other.txt",
        }),
      ).rejects.toThrow("Pinned sandbox destination does not match the requested path");
    });
  });

  it("runs stat under the C locale so missing-file errors return null", async () => {
    await withTempDir("openclaw-fs-bridge-stat-missing-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      mockedExecDockerRaw.mockImplementation(async (args) => {
        const script = getDockerScript(args);
        if (script.includes('readlink -n -f -- "$cursor"')) {
          return dockerExecResult(`${getDockerArg(args, 1)}\n`);
        }
        if (script.includes('stat -c "%F|%s|%y"')) {
          const stderr = script.includes('LC_ALL=C stat -c "%F|%s|%y"')
            ? "stat: cannot stat 'note.txt': No such file or directory\n"
            : "stat: der Aufruf von statx für 'note.txt' ist nicht möglich: Datei oder Verzeichnis nicht gefunden\n";
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(stderr),
            code: 1,
          };
        }
        return dockerExecResult("");
      });

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toBeNull();
      await expect(
        bridge.stat({ filePath: "note.txt", expectedPolicyPath: "/workspace/note.txt" }),
      ).resolves.toBeNull();

      const statCall = requireDockerCall(
        findCallByScriptFragment('stat -c "%F|%s|%y" -- "$2"'),
        "stat",
      );
      expect(getDockerScript(statCall[0])).toContain('LC_ALL=C stat -c "%F|%s|%y" -- "$2"');
    });
  });

  it("keeps non-missing stat failures as errors", async () => {
    await withTempDir("openclaw-fs-bridge-stat-error-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      mockedExecDockerRaw.mockImplementation(async (args) => {
        const script = getDockerScript(args);
        if (script.includes('readlink -n -f -- "$cursor"')) {
          return dockerExecResult(`${getDockerArg(args, 1)}\n`);
        }
        if (script.includes('stat -c "%F|%s|%y"')) {
          return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("stat: cannot stat 'note.txt': Permission denied\n"),
            code: 1,
          };
        }
        return dockerExecResult("");
      });

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.stat({ filePath: "note.txt" })).rejects.toThrow("Permission denied");

      const failure = new FsSafeError("path-mismatch", "descriptor identity changed", {
        cause: Object.assign(new Error("missing during final admission"), { code: "ENOENT" }),
      });
      mockedOpenRootFile.mockResolvedValueOnce({
        ok: false,
        reason: "validation",
        error: failure,
      });
      await expect(
        bridge.stat({ filePath: "note.txt", expectedPolicyPath: "/workspace/note.txt" }),
      ).rejects.toBe(failure);
    });
  });

  it("saturates unsafe stat size output", async () => {
    await withTempDir("openclaw-fs-bridge-stat-parse-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      mockedExecDockerRaw.mockImplementation(async (args) => {
        const script = getDockerScript(args);
        if (script.includes('readlink -n -f -- "$cursor"')) {
          return dockerExecResult(`${getDockerArg(args, 1)}\n`);
        }
        if (script.includes('stat -c "%F|%s|%y"')) {
          return dockerExecResult("regular file|9007199254740992|8640000000001\n");
        }
        return dockerExecResult("");
      });

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toMatchObject({
        type: "file",
        size: Number.MAX_SAFE_INTEGER,
        mtimeMs: 0,
      });
    });
  });
});
