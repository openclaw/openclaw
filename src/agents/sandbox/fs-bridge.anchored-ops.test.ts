import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import {
  createSandbox,
  createSandboxFsBridge,
  dockerExecResult,
  findCallByDockerArg,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  mockedOpenRootFile,
} from "./fs-bridge.test-helpers.js";

function mockStat(stat: (script: string) => ReturnType<typeof dockerExecResult>) {
  mockedExecDockerRaw.mockImplementation(async (args) => {
    const script = getDockerScript(args);
    if (script.includes('readlink -n -f -- "$cursor"')) {
      return dockerExecResult(`${getDockerArg(args, 1)}\n`);
    }
    return script.includes('stat -c "%F|%s|%y"') ? stat(script) : dockerExecResult("");
  });
}

describe("sandbox fs bridge anchored ops", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  let workspaceDir: string;
  let bridge: ReturnType<typeof createSandboxFsBridge>;
  let readGate: ((fd: number) => Promise<void>) | undefined;
  installFsBridgeTestHarness({
    beforeAsyncRead: async (fd) => {
      await readGate?.(fd);
    },
  });
  beforeEach(async () => {
    workspaceDir = path.join(dirs.make("openclaw-fs-bridge-anchored-"), "workspace");
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "from.txt"), "hello");
    bridge = createSandboxFsBridge({
      sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
    });
  });

  it.each([
    { name: "uncapped", contents: "hello", maxBytes: undefined },
    { name: "chunked", contents: "x".repeat(64 * 1024 + 1), maxBytes: 64 * 1024 + 1 },
  ])("yields during $name reads without losing the pinned file", async ({ contents, maxBytes }) => {
    await fs.writeFile(path.join(workspaceDir, "from.txt"), contents);
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

    let actual: Buffer;
    try {
      actual = await bridge.readFile({ filePath: "from.txt", maxBytes });
      events.push("read-complete");
    } finally {
      await heartbeat;
      readGate = undefined;
    }
    expect(actual).toEqual(Buffer.from(contents));
    expect(events).toEqual(["event-loop", "read-complete"]);
    expect(() => fsSync.fstatSync(openedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("rejects negative limits without an unbounded read", async () => {
    await expect(bridge.readFile({ filePath: "from.txt", maxBytes: -1 })).rejects.toThrow(
      /non-negative safe integer/,
    );
  });

  it("rejects growth after opening the descriptor", async () => {
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
  });

  it("allows dot-dot names without treating them as traversal", async () => {
    expect(bridge.resolvePath({ filePath: "..cache" })).toMatchObject({
      relativePath: "..cache",
      containerPath: "/workspace/..cache",
    });
    await bridge.mkdirp({ filePath: "..cache" });

    const mkdirCall = findCallByDockerArg(1, "mkdirp");
    expect(mkdirCall).toBeDefined();
    expect(mkdirCall![0].slice(8, 10)).toEqual(["/workspace", "..cache"]);
  });

  it("rejects a mismatched pinned basename", async () => {
    await expect(
      bridge.writeFile({
        filePath: "notes/todo.txt",
        data: "updated",
        pinnedPath: "/workspace/notes/other.txt",
      }),
    ).rejects.toThrow("Pinned sandbox destination does not match the requested path");
  });

  it("uses C-locale stat errors to recognize missing files", async () => {
    mockStat((script) => ({
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
  });

  it("keeps non-missing stat failures as errors", async () => {
    mockStat(() => ({
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
});
