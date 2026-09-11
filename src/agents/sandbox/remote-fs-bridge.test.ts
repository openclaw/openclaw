// Remote filesystem bridge tests cover SSH-style sandbox file operations using
// the pinned mutation helper and remote stat/path guards.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSandboxedReadTool, createSandboxedWriteTool } from "../agent-tools.read.js";
import { resolveSandboxFileMutationQueueKey } from "./file-mutation-identity.js";
import { SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL } from "./fs-bridge-mutation-helper.js";
import {
  SANDBOX_CREATE_EXISTS_EXIT_CODE,
  SANDBOX_PINNED_MUTATION_PYTHON,
} from "./fs-bridge-mutation-python.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import {
  createLocalRemoteShellScriptRunner,
  spawnLocalRemoteShellAsync,
  type LocalRemoteShellSpawn,
  type LocalRemoteShellSpawnResult,
} from "./remote-fs-bridge.test-helpers.js";

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
      if (command.script.includes('readlink -f -- "$cursor"')) {
        return shellResult(`${workspaceDir}/note.txt\n${workspaceDir}\n`);
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

function createLocalRemoteRuntime(params: {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  spawn?: LocalRemoteShellSpawn;
}) {
  // Execute remote shell snippets locally so the bridge scripts are exercised
  // without a real SSH host.
  const calls: Array<Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]> = [];
  const runtime: RemoteShellSandboxHandle = {
    remoteWorkspaceDir: params.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir,
    runRemoteShellScript: createLocalRemoteShellScriptRunner({
      spawn: params.spawn,
      onCommand: (command) => calls.push(command),
    }),
  };
  return { calls, runtime };
}

function createWorkspaceReadBridge(workspaceDir: string) {
  const { runtime } = createLocalRemoteRuntime({
    remoteWorkspaceDir: workspaceDir,
    remoteAgentWorkspaceDir: workspaceDir,
  });
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    }),
    runtime,
  });
}

describe("remote sandbox fs bridge", () => {
  it.runIf(process.platform !== "win32").each([
    { workspaceAccess: "rw", mutation: "write" },
    { workspaceAccess: "none", mutation: "write" },
    { workspaceAccess: "ro", mutation: "write" },
    { workspaceAccess: "rw", mutation: "remove" },
    { workspaceAccess: "none", mutation: "remove" },
    { workspaceAccess: "rw", mutation: "rename" },
    { workspaceAccess: "none", mutation: "rename" },
  ] as const)(
    "enforces $workspaceAccess workspace writes and protects remote-only skills from $mutation",
    async ({ workspaceAccess, mutation }) => {
      await withTempDir("openclaw-remote-fs-payload-", async (stateDir) => {
        const workspaceDir = path.join(await fs.realpath(stateDir), "host-workspace");
        const remoteWorkspaceDir = path.join(await fs.realpath(stateDir), "remote 'workspace'");
        await fs.mkdir(workspaceDir);
        await fs.mkdir(remoteWorkspaceDir);
        const { runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir,
          remoteAgentWorkspaceDir: remoteWorkspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            workspaceAccess,
          }),
          runtime,
        });
        const filePath = "quoted ' \" $() `literal`.bin";
        const payload = Buffer.from([0, 255, 128, 10, 13, 39, 34, 36, 96]);
        const createFileExclusive = bridge.createFileExclusive!.bind(bridge);
        if (!bridge.readDirectory) {
          throw new Error("The remote bridge must support directory discovery.");
        }
        await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([]);
        await expect(bridge.readDirectory({ filePath: "../" })).rejects.toThrow();
        if (workspaceAccess === "ro") {
          await expect(createFileExclusive({ filePath, data: payload })).rejects.toThrow(
            "read-only",
          );
          await expect(fs.readdir(remoteWorkspaceDir)).resolves.toEqual([]);
          return;
        }

        await expect(createFileExclusive({ filePath, data: payload })).resolves.toBe("created");
        await expect(bridge.readFile({ filePath })).resolves.toEqual(payload);
        await expect(bridge.readDirectory({ filePath: "." })).resolves.toEqual([
          { name: filePath, isDirectory: false },
        ]);
        await expect(
          createFileExclusive({ filePath, data: Buffer.alloc(1_048_576) }),
        ).resolves.toBe("exists");
        await expect(fs.readFile(path.join(remoteWorkspaceDir, filePath))).resolves.toEqual(
          payload,
        );

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
        await expect(fs.readFile(skillPath, "utf8")).resolves.toBe("managed instructions");
      });
    },
  );

  it("preserves an authoritative create collision when stdin closes with EPIPE", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const { runtime } = createLocalRemoteRuntime({
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/workspace",
      spawn: () => ({
        error: pipeError,
        status: SANDBOX_CREATE_EXISTS_EXIT_CODE,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    });

    await expect(
      runtime.runRemoteShellScript({
        script: 'python3 -c "$python_script" "$@"',
        args: ["create", "/workspace", "", "existing.txt", "1"],
        stdin: Buffer.alloc(1_048_576),
        allowFailure: true,
      }),
    ).resolves.toMatchObject({ code: SANDBOX_CREATE_EXISTS_EXIT_CODE });
  });

  it.each([
    {
      name: "an unrecognized script",
      command: { script: "exit 17" },
      result: {},
    },
    {
      name: "a non-create operation",
      command: { args: ["read", "/workspace", "", "existing.txt"] },
      result: {},
    },
    {
      name: "a disallowed failure",
      command: { allowFailure: false },
      result: {},
    },
    {
      name: "a different exit status",
      command: {},
      result: { status: SANDBOX_CREATE_EXISTS_EXIT_CODE + 1 },
    },
    {
      name: "a signaled child",
      command: {},
      result: { status: null, signal: "SIGTERM" as NodeJS.Signals },
    },
    {
      name: "a non-EPIPE spawn error",
      command: {},
      result: { errorCode: "ECONNRESET" },
    },
  ])("keeps spawn errors fatal for $name", async ({ command, result }) => {
    const spawnError = Object.assign(new Error("spawn failed"), {
      code: "errorCode" in result ? result.errorCode : "EPIPE",
    });
    const spawnResult: LocalRemoteShellSpawnResult = {
      error: spawnError,
      status: result.status === undefined ? SANDBOX_CREATE_EXISTS_EXIT_CODE : result.status,
      signal: result.signal === undefined ? null : result.signal,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
    const { runtime } = createLocalRemoteRuntime({
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/workspace",
      spawn: () => spawnResult,
    });

    await expect(
      runtime.runRemoteShellScript({
        script: 'python3 -c "$python_script" "$@"',
        args: ["create", "/workspace", "", "existing.txt", "1"],
        stdin: Buffer.alloc(1_048_576),
        allowFailure: true,
        ...command,
      }),
    ).rejects.toBe(spawnError);
  });

  it("rejects mount-root reads before invoking the mutation helper", async () => {
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const { calls, runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.readFile({ filePath: "." })).rejects.toThrow(
        /Invalid sandbox entry target/,
      );
      expect(calls).toHaveLength(0);
    });
  });

  it("normalizes stat output locale and saturates unsafe sizes", async () => {
    // Remote stat output is untrusted shell text; unsafe numeric fields should
    // clamp to deterministic values instead of leaking NaN into callers.
    await withTempDir("openclaw-remote-fs-bridge-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: () => "regular file|1",
        stat: (script) =>
          `${script.includes('LC_ALL=C stat -c "%F|%s|%y"') ? "regular file" : "reguläre Datei"}|9007199254740992|8640000000001`,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toEqual({
        type: "file",
        size: Number.MAX_SAFE_INTEGER,
        mtimeMs: 0,
      });
    });
  });

  it("rejects hardlinked files under localized remote shells", async () => {
    await withTempDir("openclaw-remote-fs-bridge-hardlink-locale-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: (script) =>
          `${script.includes('LC_ALL=C stat -c "%F|%h"') ? "regular file" : "reguläre Datei"}|2`,
        stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).rejects.toThrow(/Hardlinked path/);
    });
  });

  it("does not reject malformed non-decimal hardlink counts", async () => {
    await withTempDir("openclaw-remote-fs-bridge-hardlink-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: () => "regular file|0x2",
        stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toMatchObject({
        type: "file",
        size: 12,
      });
    });
  });
});

// These fixtures execute remote GNU stat/readlink and the Python launcher
// locally. Portable Python behavior stays in fs-bridge-mutation-helper.test.ts.
describe.runIf(process.platform === "linux")("remote sandbox fs bridge (GNU shell)", () => {
  it("joins concurrent writes that race to create the same absent parent", async () => {
    await withTempDir("openclaw-remote-fs-parent-race-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "host-workspace");
      const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
      const rendezvousDir = path.join(stateDir, "rendezvous");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(remoteWorkspaceDir);
      await fs.mkdir(rendezvousDir);
      // Both real Python children must observe the missing parent before either
      // may create it. The deadline also releases a child if its peer fails.
      const source = SANDBOX_PINNED_MUTATION_PYTHON.replace(
        "            except FileNotFoundError:",
        [
          "            except FileNotFoundError:",
          "                if segment == 'shared':",
          "                    import time",
          `                    rendezvous = ${JSON.stringify(rendezvousDir)}`,
          "                    ready_fd = os.open(os.path.join(rendezvous, sys.argv[4]), WRITE_FLAGS, 0o600)",
          "                    os.close(ready_fd)",
          "                    deadline = time.monotonic() + 5",
          "                    while len(os.listdir(rendezvous)) != 2:",
          "                        if time.monotonic() >= deadline:",
          "                            raise RuntimeError('parent creation rendezvous timed out')",
          "                        time.sleep(0.005)",
        ].join("\n"),
      );
      const shellLiteral = `'${source.replaceAll("'", "'\\''")}'`;
      const { runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir,
        remoteAgentWorkspaceDir: remoteWorkspaceDir,
        spawn: (file, args, stdin) =>
          spawnLocalRemoteShellAsync(
            file,
            args.map((arg) =>
              arg.replace(SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL, () => shellLiteral),
            ),
            stdin,
          ),
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        runtime,
      });
      // Await every child close before assertions or withTempDir can remove inputs.
      const results = await Promise.allSettled(
        ["one", "two"].map((name) =>
          bridge.writeFile({ filePath: `shared/${name}.txt`, data: name, mkdir: true }),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Concurrent remote writes failed",
        );
      }
      await expect(
        fs.readdir(rendezvousDir).then((entries) => entries.toSorted()),
      ).resolves.toEqual(["one.txt", "two.txt"]);
      await expect(
        fs.readdir(path.join(remoteWorkspaceDir, "shared")).then((entries) => entries.toSorted()),
      ).resolves.toEqual(["one.txt", "two.txt"]);
      for (const name of ["one", "two"]) {
        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "shared", `${name}.txt`), "utf8"),
        ).resolves.toBe(name);
      }
      await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
    });
  });

  it("orders sandbox tools through one remote alias identity", async () => {
    await withTempDir("openclaw-remote-fs-queue-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "host-workspace");
      const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
      await fs.mkdir(workspaceDir);
      await fs.mkdir(remoteWorkspaceDir);
      const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
      const { runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir,
        remoteAgentWorkspaceDir: remoteWorkspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({ sandbox, runtime });
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
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "remote snapshot" }),
        ]),
      );
    });
  });

  it("creates files exclusively and preserves existing entries", async () => {
    await withTempDir("openclaw-remote-fs-create-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const { runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        runtime,
      });
      const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
      expect(createFileExclusive).toBeTypeOf("function");

      await expect(
        createFileExclusive!({ filePath: "nested/note.txt", data: "first" }),
      ).resolves.toBe("created");
      await expect(
        createFileExclusive!({ filePath: "nested/note.txt", data: "replacement" }),
      ).resolves.toBe("exists");
      await expect(
        fs.readFile(path.join(workspaceDir, "nested", "note.txt"), "utf8"),
      ).resolves.toBe("first");

      const outcomes = await Promise.all([
        createFileExclusive!({ filePath: "race.txt", data: "one" }),
        createFileExclusive!({ filePath: "race.txt", data: "two" }),
      ]);
      expect(outcomes.toSorted()).toEqual(["created", "exists"]);
      await expect(fs.readFile(path.join(workspaceDir, "race.txt"), "utf8")).resolves.toMatch(
        /^(one|two)$/u,
      );
    });
  });

  it("treats a symlink destination as existing without changing its target", async () => {
    await withTempDir("openclaw-remote-fs-create-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "target.txt"), "keep", "utf8");
      await fs.symlink("target.txt", path.join(workspaceDir, "link.txt"));
      const { runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        runtime,
      });
      const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
      expect(createFileExclusive).toBeTypeOf("function");

      await expect(
        createFileExclusive!({ filePath: "link.txt", data: Buffer.alloc(1_048_576) }),
      ).resolves.toBe("exists");
      await expect(fs.readFile(path.join(workspaceDir, "target.txt"), "utf8")).resolves.toBe(
        "keep",
      );
    });
  });

  it("accepts a symlinked mount root while rejecting escapes through it", async () => {
    await withTempDir("openclaw-remote-fs-linked-root-", async (stateDir) => {
      const realWorkspaceDir = path.join(stateDir, "real-workspace");
      const linkedWorkspaceDir = path.join(stateDir, "linked-workspace");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(realWorkspaceDir);
      await fs.mkdir(outsideDir);
      await fs.symlink(realWorkspaceDir, linkedWorkspaceDir, "dir");
      await fs.symlink(outsideDir, path.join(realWorkspaceDir, "escape"), "dir");
      const { runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: linkedWorkspaceDir,
        remoteAgentWorkspaceDir: linkedWorkspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir: linkedWorkspaceDir,
          agentWorkspaceDir: linkedWorkspaceDir,
        }),
        runtime,
      });
      const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
      expect(createFileExclusive).toBeTypeOf("function");

      await expect(createFileExclusive!({ filePath: "inside.txt", data: "inside" })).resolves.toBe(
        "created",
      );
      await expect(bridge.readFile({ filePath: "inside.txt" })).resolves.toEqual(
        Buffer.from("inside"),
      );
      await expect(bridge.mkdirp({ filePath: "nested/dir" })).resolves.toBeUndefined();
      await expect(fs.readFile(path.join(realWorkspaceDir, "inside.txt"), "utf8")).resolves.toBe(
        "inside",
      );
      await expect(
        fs.stat(path.join(realWorkspaceDir, "nested", "dir")).then((entry) => entry.isDirectory()),
      ).resolves.toBe(true);
      await expect(
        createFileExclusive!({ filePath: "escape/outside.txt", data: "blocked" }),
      ).rejects.toThrow(/escapes allowed mounts/);
      await expect(bridge.mkdirp({ filePath: "escape/dir" })).rejects.toThrow(
        /escapes allowed mounts/,
      );
    });
  });

  it("reads files with the pinned mutation helper", async () => {
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspacePath = path.join(stateDir, "workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      const workspaceDir = await fs.realpath(workspacePath);
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");

      const { calls, runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.readFile({ filePath: "note.txt" })).resolves.toEqual(
        Buffer.from("hello"),
      );
      expect(calls).toHaveLength(2);
    });
  });

  it("forwards and enforces bounded pinned file reads", async () => {
    await withTempDir("openclaw-remote-fs-bounded-read-", async (stateDir) => {
      const workspacePath = path.join(stateDir, "workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      const workspaceDir = await fs.realpath(workspacePath);
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");

      const { calls, runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        runtime,
      });

      await expect(bridge.readFile({ filePath: "note.txt", maxBytes: 5 })).resolves.toEqual(
        Buffer.from("hello"),
      );
      expect(calls.find((call) => call.args?.[0] === "read")?.args).toEqual([
        "read",
        workspaceDir,
        "",
        "note.txt",
        "5",
      ]);
      await expect(bridge.readFile({ filePath: "note.txt", maxBytes: 4 })).rejects.toThrow(
        /bounded read limit/i,
      );
      await expect(bridge.readFile({ filePath: "note.txt", maxBytes: -1 })).rejects.toThrow(
        /non-negative safe integer/i,
      );
      expect(calls).toHaveLength(4);
    });
  });

  it("streams file copies with the pinned mutation helper", async () => {
    await withTempDir("openclaw-remote-fs-copy-", async (stateDir) => {
      const workspacePath = path.join(stateDir, "workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      const workspaceDir = await fs.realpath(workspacePath);
      await fs.writeFile(path.join(workspaceDir, "source.txt"), "streamed", "utf8");
      const { calls, runtime } = createLocalRemoteRuntime({
        remoteWorkspaceDir: workspaceDir,
        remoteAgentWorkspaceDir: workspaceDir,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
        runtime,
      });

      const copyFile = bridge.copyFile?.bind(bridge);
      expect(copyFile).toBeTypeOf("function");
      await copyFile!({
        sourcePath: "source.txt",
        destinationPath: "nested/copy.txt",
      });

      await expect(
        fs.readFile(path.join(workspaceDir, "nested", "copy.txt"), "utf8"),
      ).resolves.toBe("streamed");
      expect(calls.some((call) => call.args?.[0] === "copy")).toBe(true);
    });
  });

  it("reads dot-dot-prefixed filenames inside the workspace", async () => {
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "..note.txt"), "hidden", "utf8");

      const bridge = createWorkspaceReadBridge(workspaceDir);

      expect(bridge.resolvePath({ filePath: "..note.txt" })).toMatchObject({
        relativePath: "..note.txt",
        containerPath: `${workspaceDir}/..note.txt`,
      });
      await expect(bridge.readFile({ filePath: "..note.txt" })).resolves.toEqual(
        Buffer.from("hidden"),
      );
    });
  });

  it("rejects symlink escapes while reading", async () => {
    // The remote helper uses no-follow file opens; symlinked final components
    // must fail even when the local caller cannot inspect the remote inode.
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified", "utf8");
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(workspaceDir, "link.txt"));

      const bridge = createWorkspaceReadBridge(workspaceDir);

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
        /symbolic links|too many levels|ELOOP/i,
      );
    });
  });

  it("rejects final-component symlinks even when they stay inside the workspace", async () => {
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");
      await fs.symlink("note.txt", path.join(workspaceDir, "link.txt"));

      const bridge = createWorkspaceReadBridge(workspaceDir);

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
        /symbolic links|too many levels|ELOOP/i,
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "authorizes logical policy paths and pins physical canonical destinations with observed final effects",
    async () => {
      await withTempDir("openclaw-remote-fs-pinned-", async (stateDir) => {
        const hostWorkspaceDir = path.join(await fs.realpath(stateDir), "host-workspace");
        const realWorkspaceDir = path.join(await fs.realpath(stateDir), "real-workspace");
        const linkedWorkspaceDir = path.join(await fs.realpath(stateDir), "linked-workspace");
        await fs.mkdir(hostWorkspaceDir);
        await fs.mkdir(realWorkspaceDir);
        // The remote-visible workspace root is itself an alias: policy grants
        // use the logical namespace while canonicalization resolves to the
        // physical root.
        await fs.symlink(realWorkspaceDir, linkedWorkspaceDir);
        const { runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: linkedWorkspaceDir,
          remoteAgentWorkspaceDir: linkedWorkspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: hostWorkspaceDir,
            agentWorkspaceDir: hostWorkspaceDir,
          }),
          runtime,
        });

        const realDir = path.join(realWorkspaceDir, "real");
        const decoyDir = path.join(realWorkspaceDir, "decoy");
        await fs.mkdir(realDir);
        await fs.mkdir(decoyDir);
        await fs.symlink(realDir, path.join(linkedWorkspaceDir, "alias"));
        await fs.writeFile(path.join(linkedWorkspaceDir, "source.txt"), "copy-source");

        // The policy view stays in the logical namespace; the pin resolves to
        // the physical canonical destination.
        const writeTarget = await bridge.resolvePinnedMutationTarget!({
          filePath: "note.txt",
          action: "write",
        });
        expect(writeTarget.policyPath).toBe(path.join(linkedWorkspaceDir, "note.txt"));
        expect(writeTarget.pinnedPath).toBe(path.join(realWorkspaceDir, "note.txt"));
        await bridge.writeFile({
          filePath: "note.txt",
          data: "pinned",
          pinnedPath: writeTarget.pinnedPath,
        });
        await expect(fs.readFile(path.join(realWorkspaceDir, "note.txt"), "utf8")).resolves.toBe(
          "pinned",
        );

        // Post-authorization alias swap: the pinned write cannot be redirected.
        const aliasTarget = await bridge.resolvePinnedMutationTarget!({
          filePath: "alias/note.txt",
          action: "write",
        });
        expect(aliasTarget.pinnedPath).toBe(path.join(realDir, "note.txt"));
        await fs.unlink(path.join(linkedWorkspaceDir, "alias"));
        await fs.symlink(decoyDir, path.join(linkedWorkspaceDir, "alias"));
        await bridge.writeFile({
          filePath: "alias/note.txt",
          data: "after-swap",
          pinnedPath: aliasTarget.pinnedPath,
        });
        await expect(fs.readFile(path.join(realDir, "note.txt"), "utf8")).resolves.toBe(
          "after-swap",
        );
        await expect(fs.stat(path.join(decoyDir, "note.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        // Restore the alias, then remove exactly the authorized entry.
        await fs.unlink(path.join(linkedWorkspaceDir, "alias"));
        await fs.symlink(realDir, path.join(linkedWorkspaceDir, "alias"));
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
        await expect(fs.stat(path.join(realDir, "gone.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.readFile(path.join(realDir, "keep.txt"), "utf8")).resolves.toBe("keep-me");

        // Directory creation through an alias: the directory pin follows the
        // canonical directory even when the alias renames it.
        const mkdirTarget = await bridge.resolvePinnedMutationTarget!({
          filePath: "alias/newdir",
          action: "mkdir",
        });
        expect(mkdirTarget.policyPath).toBe(path.join(linkedWorkspaceDir, "real", "newdir"));
        expect(mkdirTarget.pinnedPath).toBe(path.join(realWorkspaceDir, "real", "newdir"));
        await bridge.mkdirp({ filePath: "alias/newdir", pinnedPath: mkdirTarget.pinnedPath });
        expect((await fs.stat(path.join(realWorkspaceDir, "real", "newdir"))).isDirectory()).toBe(
          true,
        );

        // Recursive creation of the (symlinked) mount root stays an authorized
        // no-op with logical policy and physical pin views.
        const rootTarget = await bridge.resolvePinnedMutationTarget!({
          filePath: ".",
          action: "mkdir",
        });
        expect(rootTarget.policyPath).toBe(linkedWorkspaceDir);
        expect(rootTarget.pinnedPath).toBe(realWorkspaceDir);
        await bridge.mkdirp({ filePath: ".", pinnedPath: rootTarget.pinnedPath });
      });
    },
  );
});

async function withTempDir<T>(prefix: string, run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
