// Codex tests cover sandbox exec server.fs plugin behavior.
import type { SandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  globPath,
  openSocket,
  rpc,
  specialPath,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

async function openSandboxSocket(sandbox: ReturnType<typeof createSandboxContext>) {
  const client = createClient();
  await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
  const socket = await openSocket(execServerUrlFromClient(client));
  await rpc(socket, "initialize", { clientName: "test" });
  socket.send(JSON.stringify({ method: "initialized" }));
  return socket;
}

describe("OpenClaw Codex sandbox exec-server filesystem", () => {
  it("returns the required Codex file size in sandbox metadata", async () => {
    const sandbox = createSandboxContext({
      stat: async () => ({ type: "file", size: 1234, mtimeMs: 5678 }),
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/getMetadata", { path: "file:///workspace/attachment.txt" }),
    ).resolves.toEqual({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: 1234,
      createdAtMs: 0,
      modifiedAtMs: 5678,
    });
    socket.close();
  });

  it("keeps pre-upgrade sandbox fs bridges source- and runtime-compatible", async () => {
    const writeFile = vi.fn(
      async (_params: {
        filePath: string;
        data: Buffer | string;
        encoding?: BufferEncoding;
        mkdir?: boolean;
        signal?: AbortSignal;
      }) => undefined,
    );
    const copyFile = vi.fn(
      async (_params: {
        sourcePath: string;
        destinationPath: string;
        cwd?: string;
        mkdir?: boolean;
        signal?: AbortSignal;
      }) => undefined,
    );
    const mkdirp = vi.fn(
      async (_params: { filePath: string; cwd?: string; signal?: AbortSignal }) => undefined,
    );
    const remove = vi.fn(
      async (_params: {
        filePath: string;
        cwd?: string;
        recursive?: boolean;
        force?: boolean;
        signal?: AbortSignal;
      }) => undefined,
    );
    // Deliberately model the interface shipped before canonical mutation pins:
    // no resolvePinnedMutationTarget method and no pinnedPath parameters.
    const legacyBridge = {
      resolvePath: ({ filePath }: { filePath: string; cwd?: string }) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      readFile: async () => Buffer.alloc(0),
      copyFile,
      writeFile,
      mkdirp,
      remove,
      rename: async () => undefined,
      stat: async ({ filePath }: { filePath: string; cwd?: string; signal?: AbortSignal }) => ({
        type: /\.[^/]+$/u.test(filePath) ? ("file" as const) : ("directory" as const),
        size: 1,
        mtimeMs: 1,
      }),
    } satisfies SandboxFsBridge;
    const sandbox = { ...createSandboxContext({}), fsBridge: legacyBridge };
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/legacy.txt",
        dataBase64: Buffer.from("compatible").toString("base64"),
      }),
    ).resolves.toEqual({});

    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/legacy.txt",
      data: Buffer.from("compatible"),
      mkdir: false,
    });

    await expect(
      rpc(socket, "fs/createDirectory", {
        path: "file:///workspace/legacy-dir",
        recursive: true,
      }),
    ).resolves.toEqual({});
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/legacy-dir" });

    await expect(
      rpc(socket, "fs/copy", {
        sourcePath: "file:///workspace/source.txt",
        destinationPath: "file:///workspace/copied.txt",
      }),
    ).resolves.toEqual({});
    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/source.txt",
      destinationPath: "/workspace/copied.txt",
      mkdir: true,
    });

    await expect(
      rpc(socket, "fs/remove", {
        path: "file:///workspace/legacy.txt",
        recursive: false,
        force: false,
      }),
    ).resolves.toEqual({});
    expect(remove).toHaveBeenCalledWith({
      filePath: "/workspace/legacy.txt",
      recursive: false,
      force: false,
    });
    socket.close();
  });

  it("preserves missing-parent failures for file writes", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      stat: async ({ filePath }) =>
        filePath === "/workspace" ? { type: "directory", size: 1, mtimeMs: 1 } : null,
      writeFile,
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/missing/note.txt",
        dataBase64: Buffer.from("hello").toString("base64"),
      }),
    ).rejects.toThrow("parent directory not found");

    expect(writeFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("denies copies whose canonical destination is policy-protected", async () => {
    const copyFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      copyFile,
      resolvePinnedMutationTarget: async ({ filePath }) =>
        filePath === "/workspace/alias/config"
          ? { policyPath: "/workspace/.git/config", pinnedPath: "/workspace/.git/config" }
          : { policyPath: filePath, pinnedPath: filePath },
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/copy", {
        sourcePath: "file:///workspace/source.txt",
        destinationPath: "file:///workspace/alias/config",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: specialPath("project_roots", ".git"), access: "read" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");

    expect(copyFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("honors Codex fs sandbox protected metadata carveouts", async () => {
    const remove = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ remove, writeFile });
    const socket = await openSandboxSocket(sandbox);
    const workspacePolicy = codexFsSandboxContext({
      entries: [
        { path: specialPath("root"), access: "read" },
        { path: specialPath("project_roots"), access: "write" },
        { path: specialPath("project_roots", ".git"), access: "read" },
      ],
    });

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/.git/config",
        dataBase64: Buffer.from("blocked").toString("base64"),
        sandbox: workspacePolicy,
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");
    await expect(
      rpc(socket, "fs/remove", {
        path: "file:///workspace",
        recursive: true,
        force: true,
        sandbox: workspacePolicy,
      }),
    ).rejects.toThrow("because /workspace/.git is not writable");

    expect(writeFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    socket.close();
  });

  it("enforces Codex fs sandbox glob deny entries", async () => {
    const remove = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ readFile, remove, writeFile });
    const socket = await openSandboxSocket(sandbox);
    const policy = codexFsSandboxContext({
      entries: [
        { path: specialPath("root"), access: "read" },
        { path: specialPath("project_roots"), access: "write" },
        { path: globPath("private/*.txt"), access: "deny" },
      ],
    });

    await expect(
      rpc(socket, "fs/readFile", {
        path: "file:///workspace/private/secret.txt",
        sandbox: policy,
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    await expect(
      rpc(socket, "fs/readFile", {
        path: "file:///workspace/key.pem",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: globPath("**/*.pem"), access: "deny" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    await expect(
      rpc(socket, "fs/readFile", {
        path: "file:///workspace/KEY.PEM",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: globPath("**/*.[Pp][Ee][Mm]"), access: "deny" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/private/nested/allowed.txt",
      dataBase64: Buffer.from("ok").toString("base64"),
      sandbox: policy,
    });
    await expect(
      rpc(socket, "fs/remove", {
        path: "file:///workspace/private",
        recursive: true,
        force: true,
        sandbox: policy,
      }),
    ).rejects.toThrow("because /workspace/private/*.txt is not writable");

    expect(readFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it("denies a bridge-resolved read path before content or metadata leaves", async () => {
    const readFile = vi.fn(async () => Buffer.from("blocked"));
    const stat = vi.fn(async () => ({ type: "file" as const, size: 7, mtimeMs: 1 }));
    const sandbox = createSandboxContext({
      readFile,
      resolveReadPolicyPath: async () => "/workspace/private/secret.txt",
      stat,
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
    const policy = codexFsSandboxContext({
      entries: [
        { path: specialPath("root"), access: "read" },
        { path: specialPath("project_roots"), access: "write" },
        { path: { type: "path", path: "file:///workspace/private" }, access: "deny" },
      ],
    });

    for (const [method, params] of [
      ["fs/open", { handleId: "read", path: "file:///workspace/allowed.txt" }],
      ["fs/readFile", { path: "file:///workspace/allowed.txt" }],
      ["fs/getMetadata", { path: "file:///workspace/allowed.txt" }],
    ] as const) {
      await expect(rpc(socket, method, { ...params, sandbox: policy })).rejects.toThrow(
        "Codex fs sandbox denied read access",
      );
    }

    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("ignores non-granting Codex fs sandbox special entries", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ writeFile });
    const socket = await openSandboxSocket(sandbox);

    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/allowed.txt",
      dataBase64: Buffer.from("ok").toString("base64"),
      sandbox: codexFsSandboxContext({
        entries: [
          { path: specialPath("minimal"), access: "read" },
          { path: specialPath("unknown"), access: "read" },
          { path: specialPath("current_working_directory"), access: "write" },
        ],
      }),
    });

    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/allowed.txt",
      data: Buffer.from("ok"),
      mkdir: false,
    });
    socket.close();
  });

  it("fails closed for unsupported Codex fs sandbox glob classes", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const sandbox = createSandboxContext({ readFile });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/readFile", {
        path: "file:///workspace/key.pem",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: globPath("**/*.[Pp"), access: "deny" },
          ],
        }),
      }),
    ).rejects.toThrow("fs sandbox glob character class must be closed");

    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("fails closed for recursive removes below protected glob prefixes", async () => {
    const remove = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ remove });
    const socket = await openSandboxSocket(sandbox);
    const policy = codexFsSandboxContext({
      entries: [
        { path: specialPath("root"), access: "read" },
        { path: specialPath("project_roots"), access: "write" },
        { path: globPath("**/*.pem"), access: "deny" },
      ],
    });

    await expect(
      rpc(socket, "fs/remove", {
        path: "file:///workspace/src",
        recursive: true,
        force: true,
        sandbox: policy,
      }),
    ).rejects.toThrow("because /workspace/**/*.pem is not writable");

    expect(remove).not.toHaveBeenCalled();
    socket.close();
  });

  it("routes recursive copies through the sandbox filesystem bridge", async () => {
    const copyFile = vi.fn(async () => undefined);
    const mkdirp = vi.fn(async () => undefined);
    const runShellCommand = vi.fn(async (_params?: { args?: string[] }) => ({
      stdout: Buffer.from("ffile.txt\0dsubdir\0"),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    runShellCommand.mockImplementation(async (params?: { args?: string[] }) => ({
      stdout: Buffer.from(
        params?.args?.[0] === "/workspace/source-dir/subdir"
          ? "fnested.txt\0"
          : "ffile.txt\0dsubdir\0",
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({
      copyFile,
      mkdirp,
      runShellCommand,
      stat: async ({ filePath }) => ({
        type: filePath.endsWith("source-dir") || filePath.endsWith("subdir") ? "directory" : "file",
        size: 1,
        mtimeMs: 1,
      }),
    });
    const socket = await openSandboxSocket(sandbox);

    await rpc(socket, "fs/copy", {
      sourcePath: "file:///workspace/source-dir",
      destinationPath: "file:///workspace/destination-dir",
      recursive: true,
    });

    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/destination-dir" });
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/destination-dir/subdir" });
    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/source-dir/file.txt",
      destinationPath: "/workspace/destination-dir/file.txt",
      mkdir: true,
    });
    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/source-dir/subdir/nested.txt",
      destinationPath: "/workspace/destination-dir/subdir/nested.txt",
      mkdir: true,
    });
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["/workspace/source-dir"] }),
    );
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["/workspace/source-dir/subdir"] }),
    );
    socket.close();
  });

  it("bounds buffered file copies when a sandbox bridge cannot stream them", async () => {
    const data = Buffer.from("copy me");
    const readFile = vi.fn(async () => data);
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
      writeFile,
    });
    if (sandbox.fsBridge) {
      sandbox.fsBridge.copyFile = undefined;
    }
    const socket = await openSandboxSocket(sandbox);

    await rpc(socket, "fs/copy", {
      sourcePath: "file:///workspace/source.txt",
      destinationPath: "file:///workspace/destination.txt",
    });

    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/source.txt",
      maxBytes: 512 * 1024 * 1024,
    });
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/destination.txt",
      data,
      mkdir: true,
    });
    socket.close();
  });

  it("bounds legacy whole-file reads within the sandbox filesystem bridge", async () => {
    const data = Buffer.from("bounded legacy read");
    const readFile = vi.fn(async () => data);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/readFile", { path: "file:///workspace/note.txt" }),
    ).resolves.toEqual({ dataBase64: data.toString("base64") });
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/note.txt",
      maxBytes: 512 * 1024 * 1024,
    });
    socket.close();
  });

  it("rejects oversized file reads before buffering through the fs bridge", async () => {
    const readFile = vi.fn(async () => Buffer.from("too-large"));
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({
        type: "file",
        size: 512 * 1024 * 1024 + 1,
        mtimeMs: 1,
      }),
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/readFile", { path: "file:///workspace/huge.bin" }),
    ).rejects.toThrow("file is too large to read through Codex sandbox exec-server");

    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("does not create parent directories for non-recursive directory creation", async () => {
    const mkdirp = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      mkdirp,
      stat: async ({ filePath }) =>
        filePath === "/workspace/existing" ? { type: "directory", size: 1, mtimeMs: 1 } : null,
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/createDirectory", {
        path: "file:///workspace/missing/child",
        recursive: false,
      }),
    ).rejects.toThrow("parent directory not found");
    expect(mkdirp).not.toHaveBeenCalled();

    await rpc(socket, "fs/createDirectory", {
      path: "file:///workspace/existing/child",
      recursive: false,
    });
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/existing/child" });
    socket.close();
  });
});

describe("OpenClaw Codex sandbox exec-server filesystem streaming", () => {
  it("streams sandbox files through connection-owned Codex file handles", async () => {
    const data = Buffer.from("0123456789");
    const readFile = vi.fn(async () => data);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/open", {
        handleId: "stream-1",
        path: "file:///workspace/attachment.txt",
      }),
    ).resolves.toEqual({ handleId: "stream-1" });

    for (const [offset, len, expected, eof] of [
      [6, 3, "678", false],
      [1, 2, "12", false],
      [8, 4, "89", true],
      [8, 2, "89", true],
      [0, 2, "01", false],
      [0, 10, "0123456789", true],
      [10, 2, "", true],
    ] as const) {
      await expect(
        rpc(socket, "fs/readBlock", { handleId: "stream-1", offset, len }),
      ).resolves.toEqual({
        chunk: Buffer.from(expected).toString("base64"),
        eof,
      });
    }

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/attachment.txt",
      maxBytes: data.byteLength,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "stream-1", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    socket.close();
  });

  it("isolates file handles between authenticated exec-server connections", async () => {
    const readFile = vi.fn(async ({ filePath }: { filePath: string }) =>
      Buffer.from(filePath.endsWith("first.txt") ? "first" : "second"),
    );
    const sandbox = createSandboxContext({
      readFile,
      stat: async ({ filePath }) => ({
        type: "file",
        size: filePath.endsWith("first.txt") ? 5 : 6,
        mtimeMs: 1,
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const first = await openSocket(execServerUrlFromClient(client));
    const second = await openSocket(execServerUrlFromClient(client));

    for (const socket of [first, second]) {
      await rpc(socket, "initialize", { clientName: "test" });
      socket.send(JSON.stringify({ method: "initialized" }));
    }
    await rpc(first, "fs/open", {
      handleId: "shared-id",
      path: "file:///workspace/first.txt",
    });
    await rpc(second, "fs/open", {
      handleId: "shared-id",
      path: "file:///workspace/second.txt",
    });

    await expect(
      rpc(first, "fs/readBlock", { handleId: "shared-id", offset: 0, len: 6 }),
    ).resolves.toEqual({ chunk: Buffer.from("first").toString("base64"), eof: true });
    await expect(
      rpc(second, "fs/readBlock", { handleId: "shared-id", offset: 0, len: 7 }),
    ).resolves.toEqual({ chunk: Buffer.from("second").toString("base64"), eof: true });
    await rpc(first, "fs/close", { handleId: "shared-id" });
    await expect(
      rpc(second, "fs/readBlock", { handleId: "shared-id", offset: 1, len: 2 }),
    ).resolves.toEqual({ chunk: Buffer.from("ec").toString("base64"), eof: false });

    first.close();
    second.close();
  });

  it("enforces sandbox read policy before opening a streamed file", async () => {
    const readFile = vi.fn(async () => Buffer.from("secret"));
    const sandbox = createSandboxContext({ readFile });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "fs/open", {
        handleId: "denied",
        path: "file:///workspace/private/secret.txt",
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: globPath("private/*.txt"), access: "deny" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    expect(readFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("rejects duplicate, oversized, and invalid sandbox file read handles", async () => {
    const data = Buffer.from("bounded");
    const sandbox = createSandboxContext({
      readFile: async () => data,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const socket = await openSandboxSocket(sandbox);

    const path = "file:///workspace/bounded.txt";
    await rpc(socket, "fs/open", { handleId: "bounded", path });
    await expect(rpc(socket, "fs/open", { handleId: "bounded", path })).rejects.toMatchObject({
      code: -32600,
    });
    await expect(rpc(socket, "fs/open", { handleId: "x".repeat(33), path })).rejects.toMatchObject({
      code: -32600,
    });
    for (const params of [
      { handleId: "bounded", offset: -1, len: 1 },
      { handleId: "bounded", offset: 0, len: 0 },
      { handleId: "bounded", offset: 0, len: 1024 * 1024 + 1 },
    ]) {
      await expect(rpc(socket, "fs/readBlock", params)).rejects.toMatchObject({ code: -32600 });
    }
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "missing", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    socket.close();
  });

  it("bounds grown sandbox files to their pre-reserved size and releases failed handles", async () => {
    const readFile = vi
      .fn(async (_params: { filePath: string; maxBytes?: number }) => Buffer.from("small"))
      .mockResolvedValueOnce(Buffer.from("grown!"));
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: 5, mtimeMs: 1 }),
    });
    const socket = await openSandboxSocket(sandbox);

    const params = { handleId: "growing", path: "file:///workspace/growing.txt" };
    await expect(rpc(socket, "fs/open", params)).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).toHaveBeenNthCalledWith(1, {
      filePath: "/workspace/growing.txt",
      maxBytes: 5,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/open", params)).resolves.toEqual({ handleId: "growing" });
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "growing", offset: 0, len: 5 }),
    ).resolves.toEqual({ chunk: Buffer.from("small").toString("base64"), eof: true });
    socket.close();
  });

  it("caps pending sandbox stats and retains their slots until cancellation settles", async () => {
    const releaseStats = new Map<
      string,
      (stat: { type: "file"; size: number; mtimeMs: number }) => void
    >();
    const signals: AbortSignal[] = [];
    const stat = vi.fn(
      ({ filePath, signal }: { filePath: string; signal?: AbortSignal }) =>
        new Promise<{ type: "file"; size: number; mtimeMs: number }>((resolve) => {
          if (signal) {
            signals.push(signal);
          }
          releaseStats.set(filePath, resolve);
        }),
    );
    const readFile = vi.fn(async () => Buffer.from("never read"));
    const sandbox = createSandboxContext({ readFile, stat });
    const socket = await openSandboxSocket(sandbox);

    const responses = new Map<number, { error?: { code: number } }>();
    socket.on("message", (data) => {
      const response = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
        id?: number;
        error?: { code: number };
      };
      if (typeof response.id === "number") {
        responses.set(response.id, response);
      }
    });
    for (let index = 0; index < 128; index += 1) {
      socket.send(
        JSON.stringify({
          id: 20_000 + index,
          method: "fs/open",
          params: {
            handleId: `stat-${index}`,
            path: `file:///workspace/stat-${index}.bin`,
          },
        }),
      );
    }
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(128);
    });
    expect(signals).toHaveLength(128);
    expect(readFile).not.toHaveBeenCalled();

    await expect(rpc(socket, "fs/close", { handleId: "stat-0" })).resolves.toEqual({});
    expect(signals[0]?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/open", {
        handleId: "stat-0",
        path: "file:///workspace/reused.bin",
      }),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(
      rpc(socket, "fs/open", {
        handleId: "stat-overflow",
        path: "file:///workspace/overflow.bin",
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "at most 128 file reads may be open per connection",
    });
    expect(stat).toHaveBeenCalledTimes(128);
    expect(readFile).not.toHaveBeenCalled();

    releaseStats.get("/workspace/stat-0.bin")?.({ type: "file", size: 1, mtimeMs: 1 });
    await vi.waitFor(() => {
      expect(responses.get(20_000)?.error?.code).toBe(-32004);
    });
    socket.send(
      JSON.stringify({
        id: 30_000,
        method: "fs/open",
        params: { handleId: "stat-0", path: "file:///workspace/recovered.bin" },
      }),
    );
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(129);
    });
    expect(readFile).not.toHaveBeenCalled();

    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    await vi.waitFor(() => {
      expect(signals).toHaveLength(129);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    });
    for (const releaseStat of releaseStats.values()) {
      releaseStat({ type: "file", size: 1, mtimeMs: 1 });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("retains closed in-flight reservations until their sandbox reads settle", async () => {
    const halfBudget = 32 * 1024 * 1024;
    const releaseReads = new Map<string, (data: Buffer) => void>();
    const readFile = vi.fn(
      ({ filePath }: { filePath: string; maxBytes?: number; signal?: AbortSignal }) =>
        new Promise<Buffer>((resolve) => {
          releaseReads.set(filePath, resolve);
        }),
    );
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: halfBudget, mtimeMs: 1 }),
    });
    const socket = await openSandboxSocket(sandbox);

    const first = rpc(socket, "fs/open", {
      handleId: "first",
      path: "file:///workspace/first.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(1);
    });
    const firstSignal = readFile.mock.calls[0]?.[0].signal;
    await expect(rpc(socket, "fs/close", { handleId: "first" })).resolves.toEqual({});
    expect(firstSignal?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/readBlock", { handleId: "first", offset: 0, len: 1 }),
    ).rejects.toMatchObject({ code: -32004 });
    await expect(
      rpc(socket, "fs/open", {
        handleId: "first",
        path: "file:///workspace/first.txt",
      }),
    ).rejects.toMatchObject({ code: -32600 });

    const second = rpc(socket, "fs/open", {
      handleId: "second",
      path: "file:///workspace/second.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(2);
    });
    await expect(rpc(socket, "fs/close", { handleId: "second" })).resolves.toEqual({});
    expect(readFile.mock.calls[1]?.[0].signal?.aborted).toBe(true);
    await expect(
      rpc(socket, "fs/open", {
        handleId: "overflow",
        path: "file:///workspace/overflow.txt",
      }),
    ).rejects.toMatchObject({
      code: -32600,
      message: "sandbox file read exceeds the per-connection buffered file limit",
    });
    expect(readFile).toHaveBeenCalledTimes(2);

    const firstSettled = expect(first).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await firstSettled;
    const secondSettled = expect(second).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/second.txt")?.(Buffer.from("second"));
    await secondSettled;

    const recovered = rpc(socket, "fs/open", {
      handleId: "first",
      path: "file:///workspace/first.txt",
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(3);
    });
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await expect(recovered).resolves.toEqual({ handleId: "first" });
    socket.close();
  });

  it("aborts pending reads and never starts new sandbox reads after socket disconnect", async () => {
    let releaseRead: ((data: Buffer) => void) | undefined;
    let releaseStat: ((stat: { type: "file"; size: number; mtimeMs: number }) => void) | undefined;
    const readFile = vi.fn(
      (_params: { filePath: string; maxBytes?: number; signal?: AbortSignal }) =>
        new Promise<Buffer>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const stat = vi.fn(({ filePath }: { filePath: string }) => {
      if (filePath.endsWith("stat-pending.txt")) {
        return new Promise<{ type: "file"; size: number; mtimeMs: number }>((resolve) => {
          releaseStat = resolve;
        });
      }
      return Promise.resolve({ type: "file" as const, size: 5, mtimeMs: 1 });
    });
    const sandbox = createSandboxContext({ readFile, stat });
    const socket = await openSandboxSocket(sandbox);

    socket.send(
      JSON.stringify({
        id: 1,
        method: "fs/open",
        params: { handleId: "pending", path: "file:///workspace/pending.txt" },
      }),
    );
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(1);
    });
    const signal = readFile.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    socket.send(
      JSON.stringify({
        id: 2,
        method: "fs/open",
        params: { handleId: "stat-pending", path: "file:///workspace/stat-pending.txt" },
      }),
    );
    await vi.waitFor(() => {
      expect(stat).toHaveBeenCalledTimes(2);
    });

    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    // The client can close before the server observes and cancels the peer connection.
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
    });
    releaseStat?.({ type: "file", size: 5, mtimeMs: 1 });
    releaseRead?.(Buffer.from("small"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
