import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import {
  createSandbox,
  expectOnlyCanonicalPathCommands,
  createSandboxFsBridge,
  createSeededSandboxFsBridge,
  dockerExecResult,
  findCallByDockerArg,
  findCallByScriptFragment,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
} from "./fs-bridge.test-helpers.js";

type DockerRawCall = NonNullable<ReturnType<typeof findCallByDockerArg>>;

function requireDockerCall(call: DockerRawCall | undefined, label: string): DockerRawCall {
  expect(call, label).toBeDefined();
  return call!;
}

async function createStatBridge(
  stateDir: string,
  stat: (script: string) => ReturnType<typeof dockerExecResult>,
) {
  const workspaceDir = path.join(stateDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  mockedExecDockerRaw.mockImplementation(async (args) => {
    const script = getDockerScript(args);
    if (script.includes('readlink -n -f -- "$cursor"')) {
      return dockerExecResult(`${getDockerArg(args, 1)}\n`);
    }
    return script.includes('stat -c "%F|%s|%y"') ? stat(script) : dockerExecResult("");
  });
  return createSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
  });
}

describe("sandbox fs bridge anchored ops", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let stateDir: string;
  beforeEach(() => {
    stateDir = dirs.make("openclaw-fs-bridge-anchored-");
  });
  let readGate: ((fd: number) => Promise<void>) | undefined;
  installFsBridgeTestHarness({
    beforeAsyncRead: async (fd) => {
      await readGate?.(fd);
    },
  });

  it.each([
    { name: "uncapped", maxBytes: undefined },
    { name: "bounded", maxBytes: 5 },
  ])("yields during $name reads without losing the pinned file", async ({ maxBytes }) => {
    const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
    const openRootFile = mockedOpenRootFile.getMockImplementation()!;
    const events: string[] = [];
    let heartbeat: Promise<void> | undefined;
    let openedFd: number | undefined;
    mockedOpenRootFile.mockImplementationOnce(async (params) => {
      const opened = await openRootFile(params);
      if (opened.ok) {
        openedFd = opened.fd;
        await fs.rename(path.join(workspaceDir, "from.txt"), path.join(workspaceDir, "pinned.txt"));
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
    expect(() => fsSync.fstatSync(openedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("reads bounded chunks through one descriptor", async () => {
    const contents = "x".repeat(64 * 1024 + 1);
    const { bridge } = await createSeededSandboxFsBridge(stateDir, contents);

    await expect(
      bridge.readFile({ filePath: "from.txt", maxBytes: contents.length }),
    ).resolves.toEqual(Buffer.from(contents));
    expect(mockedOpenRootFile).toHaveBeenCalledTimes(1);
    expectOnlyCanonicalPathCommands();
  });

  it("rejects negative limits without an unbounded read", async () => {
    const { bridge } = await createSeededSandboxFsBridge(stateDir);

    await expect(bridge.readFile({ filePath: "from.txt", maxBytes: -1 })).rejects.toThrow(
      /non-negative safe integer/,
    );
    expect(mockedOpenRootFile).toHaveBeenCalledTimes(1);
    expectOnlyCanonicalPathCommands();
  });

  it("rejects growth after opening the descriptor", async () => {
    const { bridge, workspaceDir } = await createSeededSandboxFsBridge(stateDir);
    const openRootFile = mockedOpenRootFile.getMockImplementation()!;
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

  it("exclusive create pins canonical parent + basename", async () => {
    const { bridge } = await createSeededSandboxFsBridge(stateDir);
    await bridge.createFileExclusive!({ filePath: "nested/new.txt", data: "created" });

    const opCall = mockedExecDockerRaw.mock.calls.find(
      ([args]) =>
        getDockerScript(args).includes('exec "$python_cmd" -c "$python_script" "$@"') &&
        getDockerArg(args, 1) === "create",
    );
    const args = requireDockerCall(opCall, "exclusive create")[0];
    ["create", "/workspace", "nested", "new.txt", "1"].forEach((value, index) => {
      expect(getDockerArg(args, index + 1)).toBe(value);
    });
    expect(args).not.toContain("/workspace/nested/new.txt");
  });

  it("allows dot-dot names without treating them as traversal", async () => {
    const { bridge } = await createSeededSandboxFsBridge(stateDir);

    expect(bridge.resolvePath({ filePath: "..cache" })).toMatchObject({
      relativePath: "..cache",
      containerPath: "/workspace/..cache",
    });
    await bridge.mkdirp({ filePath: "..cache" });

    const mkdirCall = requireDockerCall(findCallByDockerArg(1, "mkdirp"), "mkdirp");
    expect(mkdirCall[0].slice(8, 10)).toEqual(["/workspace", "..cache"]);
  });

  it("rejects a mismatched pinned basename", async () => {
    const { bridge } = await createSeededSandboxFsBridge(stateDir);

    await expect(
      bridge.writeFile({
        filePath: "notes/todo.txt",
        data: "updated",
        pinnedPath: "/workspace/notes/other.txt",
      }),
    ).rejects.toThrow("Pinned sandbox destination does not match the requested path");
  });

  it("uses C-locale stat errors to recognize missing files", async () => {
    const bridge = await createStatBridge(stateDir, (script) => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(
        script.includes('LC_ALL=C stat -c "%F|%s|%y"')
          ? "stat: cannot stat 'note.txt': No such file or directory\n"
          : "stat: der Aufruf von statx für 'note.txt' ist nicht möglich: Datei oder Verzeichnis nicht gefunden\n",
      ),
      code: 1,
    }));

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

  it("keeps non-missing stat failures as errors", async () => {
    const bridge = await createStatBridge(stateDir, () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("stat: cannot stat 'note.txt': Permission denied\n"),
      code: 1,
    }));

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

  it("saturates unsafe stat size output", async () => {
    const bridge = await createStatBridge(stateDir, () =>
      dockerExecResult("regular file|9007199254740992|8640000000001\n"),
    );

    await expect(bridge.stat({ filePath: "note.txt" })).resolves.toMatchObject({
      type: "file",
      size: Number.MAX_SAFE_INTEGER,
      mtimeMs: 0,
    });
  });
});
