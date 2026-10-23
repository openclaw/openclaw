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
  openSandboxSocket,
  rpc,
  specialPath,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

const connect = (overrides: Parameters<typeof createSandboxContext>[0]) =>
  openSandboxSocket(createSandboxContext(overrides));

type Socket = Awaited<ReturnType<typeof openSocket>>;
type LegacyTarget = { filePath: string; cwd?: string; signal?: AbortSignal };
const fileStat = (size: number) => ({ type: "file" as const, size, mtimeMs: 1 });
const uri = (name: string) => `file:///workspace${name ? `/${name}` : ""}`;
function pendingIo<T>() {
  const releases = new Map<string, (value: T) => void>();
  const run = vi.fn(
    (params: LegacyTarget & { maxBytes?: number }) =>
      new Promise<T>((resolve) => {
        releases.set(params.filePath, resolve);
      }),
  );
  return { run, releases };
}
const fileRpc = (socket: Socket, method: string, name: string, params = {}) =>
  rpc(socket, `fs/${method}`, { path: uri(name), ...params });
const copy = (socket: Socket, source: string, destination: string, params = {}) =>
  rpc(socket, "fs/copy", { sourcePath: uri(source), destinationPath: uri(destination), ...params });
const openFile = (socket: Socket, handleId: string, path = uri(`${handleId}.txt`)) =>
  rpc(socket, "fs/open", { handleId, path });
const readBlock = (socket: Socket, handleId: string, offset: number, len: number) =>
  rpc(socket, "fs/readBlock", { handleId, offset, len });
const expectError = (request: Promise<unknown>, code: number, message?: string) =>
  expect(request).rejects.toMatchObject(message ? { code, message } : { code });
const write = (socket: Socket, path: string, text: string, sandbox?: unknown) =>
  rpc(socket, "fs/writeFile", {
    path,
    dataBase64: Buffer.from(text).toString("base64"),
    ...(sandbox ? { sandbox } : {}),
  });
const block = (text: string, eof: boolean) => ({
  chunk: Buffer.from(text).toString("base64"),
  eof,
});
function sendOpen(socket: Socket, id: number, handleId: string, path: string) {
  socket.send(JSON.stringify({ id, method: "fs/open", params: { handleId, path } }));
}
function makeWorkspacePolicy(path: unknown, access: "read" | "deny" = "deny") {
  return codexFsSandboxContext({
    entries: [
      { path: specialPath("root"), access: "read" },
      { path: specialPath("project_roots"), access: "write" },
      { path, access },
    ],
  });
}

describe("OpenClaw Codex sandbox exec-server filesystem", () => {
  it("returns the required Codex file size in sandbox metadata", async () => {
    const socket = await connect({
      stat: async () => ({ type: "file", size: 1234, mtimeMs: 5678 }),
    });
    await expect(fileRpc(socket, "getMetadata", "attachment.txt")).resolves.toEqual({
      isDirectory: false,
      isFile: true,
      isSymlink: false,
      size: 1234,
      createdAtMs: 0,
      modifiedAtMs: 5678,
    });
  });

  it("keeps pre-upgrade sandbox fs bridges source- and runtime-compatible", async () => {
    const writeFile = vi.fn(
      async (
        _params: Pick<LegacyTarget, "filePath" | "signal"> & {
          data: Buffer | string;
          encoding?: BufferEncoding;
          mkdir?: boolean;
        },
      ) => undefined,
    );
    const copyFile = vi.fn(
      async (
        _params: Omit<LegacyTarget, "filePath"> & {
          sourcePath: string;
          destinationPath: string;
          mkdir?: boolean;
        },
      ) => undefined,
    );
    const mkdirp = vi.fn(async (_params: LegacyTarget) => undefined);
    const remove = vi.fn(
      async (_params: LegacyTarget & { recursive?: boolean; force?: boolean }) => undefined,
    );
    // Deliberately model the interface shipped before canonical mutation pins:
    // no resolvePinnedMutationTarget method and no pinnedPath parameters.
    const legacyBridge = {
      resolvePath: ({ filePath }: LegacyTarget) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      readFile: async () => Buffer.alloc(0),
      rename: async () => undefined,
      stat: async ({ filePath }: LegacyTarget) => ({
        ...fileStat(1),
        type: /\.[^/]+$/u.test(filePath) ? ("file" as const) : ("directory" as const),
      }),
      copyFile,
      writeFile,
      mkdirp,
      remove,
    } satisfies SandboxFsBridge;
    const sandbox = { ...createSandboxContext({}), fsBridge: legacyBridge };
    const socket = await openSandboxSocket(sandbox);
    await expect(write(socket, uri("legacy.txt"), "compatible")).resolves.toEqual({});
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/legacy.txt",
      data: Buffer.from("compatible"),
      mkdir: false,
    });
    await expect(
      fileRpc(socket, "createDirectory", "legacy-dir", { recursive: true }),
    ).resolves.toEqual({});
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/legacy-dir" });
    await expect(copy(socket, "source.txt", "copied.txt")).resolves.toEqual({});
    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/source.txt",
      destinationPath: "/workspace/copied.txt",
      mkdir: true,
    });
    await expect(
      fileRpc(socket, "remove", "legacy.txt", { recursive: false, force: false }),
    ).resolves.toEqual({});
    expect(remove).toHaveBeenCalledWith({
      filePath: "/workspace/legacy.txt",
      recursive: false,
      force: false,
    });
  });

  it("preserves missing-parent failures for file writes", async () => {
    const writeFile = vi.fn(async () => undefined);
    const socket = await connect({
      stat: async ({ filePath }) =>
        filePath === "/workspace" ? { type: "directory", size: 1, mtimeMs: 1 } : null,
      writeFile,
    });
    await expect(write(socket, uri("missing/note.txt"), "hello")).rejects.toThrow(
      "parent directory not found",
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("denies copies whose canonical destination is policy-protected", async () => {
    const copyFile = vi.fn(async () => undefined);
    const socket = await connect({
      copyFile,
      resolvePinnedMutationTarget: async ({ filePath }) =>
        filePath === "/workspace/alias/config"
          ? { policyPath: "/workspace/.git/config", pinnedPath: "/workspace/.git/config" }
          : { policyPath: filePath, pinnedPath: filePath },
    });
    await expect(
      copy(socket, "source.txt", "alias/config", {
        sandbox: makeWorkspacePolicy(specialPath("project_roots", ".git"), "read"),
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("honors Codex fs sandbox protected metadata carveouts", async () => {
    const remove = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const socket = await connect({ remove, writeFile });
    const workspacePolicy = makeWorkspacePolicy(specialPath("project_roots", ".git"), "read");
    await expect(write(socket, uri(".git/config"), "blocked", workspacePolicy)).rejects.toThrow(
      "Codex fs sandbox denied write access",
    );
    await expect(
      fileRpc(socket, "remove", "", {
        recursive: true,
        force: true,
        sandbox: workspacePolicy,
      }),
    ).rejects.toThrow("because /workspace/.git is not writable");
    expect(writeFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("enforces Codex fs sandbox glob deny entries", async () => {
    const remove = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const writeFile = vi.fn(async () => undefined);
    const socket = await connect({ readFile, remove, writeFile });
    const policy = makeWorkspacePolicy(globPath("private/*.txt"));
    for (const [name, sandbox] of [
      ["private/secret.txt", policy],
      ["key.pem", makeWorkspacePolicy(globPath("**/*.pem"))],
      ["KEY.PEM", makeWorkspacePolicy(globPath("**/*.[Pp][Ee][Mm]"))],
    ] as const) {
      await expect(rpc(socket, "fs/readFile", { path: uri(name), sandbox })).rejects.toThrow(
        "Codex fs sandbox denied read access",
      );
    }
    await write(socket, uri("private/nested/allowed.txt"), "ok", policy);
    await expect(
      fileRpc(socket, "remove", "private", {
        recursive: true,
        force: true,
        sandbox: policy,
      }),
    ).rejects.toThrow("because /workspace/private/*.txt is not writable");
    expect(readFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("denies a bridge-resolved read path before content or metadata leaves", async () => {
    const readFile = vi.fn(async () => Buffer.from("blocked"));
    const stat = vi.fn(async () => ({ type: "file" as const, size: 7, mtimeMs: 1 }));
    const socket = await connect({
      readFile,
      resolveReadPolicyPath: async () => "/workspace/private/secret.txt",
      stat,
    });
    const policy = makeWorkspacePolicy({ type: "path", path: "file:///workspace/private" });
    for (const [method, params] of [
      ["open", { handleId: "read" }],
      ["readFile", {}],
      ["getMetadata", {}],
    ] as const) {
      await expect(
        fileRpc(socket, method, "allowed.txt", { ...params, sandbox: policy }),
      ).rejects.toThrow("Codex fs sandbox denied read access");
    }
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("ignores non-granting Codex fs sandbox special entries", async () => {
    const writeFile = vi.fn(async () => undefined);
    const socket = await connect({ writeFile });
    await write(
      socket,
      uri("allowed.txt"),
      "ok",
      codexFsSandboxContext({
        entries: [
          { path: specialPath("minimal"), access: "read" },
          { path: specialPath("unknown"), access: "read" },
          { path: specialPath("current_working_directory"), access: "write" },
        ],
      }),
    );
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/allowed.txt",
      data: Buffer.from("ok"),
      mkdir: false,
    });
  });

  it("fails closed for unsupported Codex fs sandbox glob classes", async () => {
    const readFile = vi.fn(async () => Buffer.from("ok"));
    const socket = await connect({ readFile });
    await expect(
      fileRpc(socket, "readFile", "key.pem", {
        sandbox: makeWorkspacePolicy(globPath("**/*.[Pp")),
      }),
    ).rejects.toThrow("fs sandbox glob character class must be closed");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("fails closed for recursive removes below protected glob prefixes", async () => {
    const remove = vi.fn(async () => undefined);
    const socket = await connect({ remove });
    const policy = makeWorkspacePolicy(globPath("**/*.pem"));
    await expect(
      fileRpc(socket, "remove", "src", {
        recursive: true,
        force: true,
        sandbox: policy,
      }),
    ).rejects.toThrow("because /workspace/**/*.pem is not writable");
    expect(remove).not.toHaveBeenCalled();
  });

  it("routes recursive copies through the sandbox filesystem bridge", async () => {
    const copyFile = vi.fn(async () => undefined);
    const mkdirp = vi.fn(async () => undefined);
    const runShellCommand = vi.fn(async (params?: { args?: string[] }) => ({
      stdout: Buffer.from(
        params?.args?.[0] === "/workspace/source-dir/subdir"
          ? "fnested.txt\0"
          : "ffile.txt\0dsubdir\0",
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const socket = await connect({
      copyFile,
      mkdirp,
      runShellCommand,
      stat: async ({ filePath }) => ({
        type: filePath.endsWith("source-dir") || filePath.endsWith("subdir") ? "directory" : "file",
        size: 1,
        mtimeMs: 1,
      }),
    });
    await rpc(socket, "fs/copy", {
      sourcePath: "file:///workspace/source-dir",
      destinationPath: "file:///workspace/destination-dir",
      recursive: true,
    });
    for (const suffix of ["", "/subdir"]) {
      expect(mkdirp).toHaveBeenCalledWith({ filePath: `/workspace/destination-dir${suffix}` });
      expect(runShellCommand).toHaveBeenCalledWith(
        expect.objectContaining({ args: [`/workspace/source-dir${suffix}`] }),
      );
    }
    for (const file of ["file.txt", "subdir/nested.txt"]) {
      expect(copyFile).toHaveBeenCalledWith({
        sourcePath: `/workspace/source-dir/${file}`,
        destinationPath: `/workspace/destination-dir/${file}`,
        mkdir: true,
      });
    }
  });

  it("bounds buffered file copies when a sandbox bridge cannot stream them", async () => {
    const data = Buffer.from("copy me");
    const readFile = vi.fn(async () => data);
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => fileStat(data.byteLength),
      writeFile,
    });
    if (sandbox.fsBridge) {
      sandbox.fsBridge.copyFile = undefined;
    }
    const socket = await openSandboxSocket(sandbox);
    await copy(socket, "source.txt", "destination.txt");
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/source.txt",
      maxBytes: 512 * 1024 * 1024,
    });
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/destination.txt",
      data,
      mkdir: true,
    });
  });

  it("bounds legacy whole-file reads within the sandbox filesystem bridge", async () => {
    const data = Buffer.from("bounded legacy read");
    const readFile = vi.fn(async () => data);
    const socket = await connect({
      readFile,
      stat: async () => fileStat(data.byteLength),
    });
    await expect(fileRpc(socket, "readFile", "note.txt")).resolves.toEqual({
      dataBase64: data.toString("base64"),
    });
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/note.txt",
      maxBytes: 512 * 1024 * 1024,
    });
  });

  it("rejects oversized file reads before buffering through the fs bridge", async () => {
    const readFile = vi.fn(async () => Buffer.from("too-large"));
    const socket = await connect({
      readFile,
      stat: async () => fileStat(512 * 1024 * 1024 + 1),
    });
    await expect(fileRpc(socket, "readFile", "huge.bin")).rejects.toThrow(
      "file is too large to read through Codex sandbox exec-server",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not create parent directories for non-recursive directory creation", async () => {
    const mkdirp = vi.fn(async () => undefined);
    const socket = await connect({
      mkdirp,
      stat: async ({ filePath }) =>
        filePath === "/workspace/existing" ? { type: "directory", size: 1, mtimeMs: 1 } : null,
    });
    await expect(
      fileRpc(socket, "createDirectory", "missing/child", { recursive: false }),
    ).rejects.toThrow("parent directory not found");
    expect(mkdirp).not.toHaveBeenCalled();
    await fileRpc(socket, "createDirectory", "existing/child", { recursive: false });
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/existing/child" });
  });
});

describe("OpenClaw Codex sandbox exec-server filesystem streaming", () => {
  it("streams sandbox files through connection-owned Codex file handles", async () => {
    const data = Buffer.from("0123456789");
    const readFile = vi.fn(async () => data);
    const socket = await connect({
      readFile,
      stat: async () => fileStat(data.byteLength),
    });
    await expect(openFile(socket, "stream-1", uri("attachment.txt"))).resolves.toEqual({
      handleId: "stream-1",
    });
    for (const [offset, len, expected, eof] of [
      [6, 3, "678", false],
      [1, 2, "12", false],
      [8, 4, "89", true],
      [8, 2, "89", true],
      [0, 2, "01", false],
      [0, 10, "0123456789", true],
      [10, 2, "", true],
    ] as const) {
      await expect(readBlock(socket, "stream-1", offset, len)).resolves.toEqual(
        block(expected, eof),
      );
    }
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith({
      filePath: "/workspace/attachment.txt",
      maxBytes: data.byteLength,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expect(rpc(socket, "fs/close", { handleId: "stream-1" })).resolves.toEqual({});
    await expectError(readBlock(socket, "stream-1", 0, 1), -32004);
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
    await openFile(first, "shared-id", uri("first.txt"));
    await openFile(second, "shared-id", uri("second.txt"));
    await expect(readBlock(first, "shared-id", 0, 6)).resolves.toEqual(block("first", true));
    await expect(readBlock(second, "shared-id", 0, 7)).resolves.toEqual(block("second", true));
    await rpc(first, "fs/close", { handleId: "shared-id" });
    await expect(readBlock(second, "shared-id", 1, 2)).resolves.toEqual(block("ec", false));
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
    const socket = await connect({
      readFile: async () => data,
      stat: async () => fileStat(data.byteLength),
    });
    const path = "file:///workspace/bounded.txt";
    await rpc(socket, "fs/open", { handleId: "bounded", path });
    await expectError(rpc(socket, "fs/open", { handleId: "bounded", path }), -32600);
    await expectError(rpc(socket, "fs/open", { handleId: "x".repeat(33), path }), -32600);
    for (const params of [
      { handleId: "bounded", offset: -1, len: 1 },
      { handleId: "bounded", offset: 0, len: 0 },
      { handleId: "bounded", offset: 0, len: 1024 * 1024 + 1 },
    ]) {
      await expectError(rpc(socket, "fs/readBlock", params), -32600);
    }
    await expectError(readBlock(socket, "missing", 0, 1), -32004);
  });

  it("bounds grown sandbox files to their pre-reserved size and releases failed handles", async () => {
    const readFile = vi
      .fn(async (_params: { filePath: string; maxBytes?: number }) => Buffer.from("small"))
      .mockResolvedValueOnce(Buffer.from("grown!"));
    const socket = await connect({
      readFile,
      stat: async () => fileStat(5),
    });
    const params = { handleId: "growing", path: "file:///workspace/growing.txt" };
    await expectError(
      rpc(socket, "fs/open", params),
      -32600,
      "sandbox file read exceeds the per-connection buffered file limit",
    );
    expect(readFile).toHaveBeenNthCalledWith(1, {
      filePath: "/workspace/growing.txt",
      maxBytes: 5,
      signal: expect.any(AbortSignal),
    });
    await expect(rpc(socket, "fs/open", params)).resolves.toEqual({ handleId: "growing" });
    await expect(readBlock(socket, "growing", 0, 5)).resolves.toEqual(block("small", true));
  });

  it("caps pending sandbox stats and retains their slots until cancellation settles", async () => {
    const { run: stat, releases: releaseStats } = pendingIo<ReturnType<typeof fileStat>>();
    const signals = () => stat.mock.calls.flatMap(([{ signal }]) => (signal ? [signal] : []));
    const readFile = vi.fn(async () => Buffer.from("never read"));
    const socket = await connect({ readFile, stat });

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
      sendOpen(socket, 20_000 + index, `stat-${index}`, uri(`stat-${index}.bin`));
    }
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(128));
    expect(signals()).toHaveLength(128);
    expect(readFile).not.toHaveBeenCalled();
    await expect(rpc(socket, "fs/close", { handleId: "stat-0" })).resolves.toEqual({});
    expect(signals()[0]?.aborted).toBe(true);
    await expectError(openFile(socket, "stat-0", uri("reused.bin")), -32600);
    await expectError(
      openFile(socket, "stat-overflow", uri("overflow.bin")),
      -32600,
      "at most 128 file reads may be open per connection",
    );
    expect(stat).toHaveBeenCalledTimes(128);
    expect(readFile).not.toHaveBeenCalled();
    releaseStats.get("/workspace/stat-0.bin")?.(fileStat(1));
    await vi.waitFor(() => expect(responses.get(20_000)?.error?.code).toBe(-32004));
    sendOpen(socket, 30_000, "stat-0", "file:///workspace/recovered.bin");
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(129));
    expect(readFile).not.toHaveBeenCalled();
    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    await vi.waitFor(() => {
      expect(signals()).toHaveLength(129);
      expect(signals().every((signal) => signal.aborted)).toBe(true);
    });
    for (const releaseStat of releaseStats.values()) {
      releaseStat(fileStat(1));
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("retains closed in-flight reservations until their sandbox reads settle", async () => {
    const halfBudget = 32 * 1024 * 1024;
    const { run: readFile, releases: releaseReads } = pendingIo<Buffer>();
    const socket = await connect({
      readFile,
      stat: async () => fileStat(halfBudget),
    });
    const first = openFile(socket, "first");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    const firstSignal = readFile.mock.calls[0]?.[0].signal;
    await expect(rpc(socket, "fs/close", { handleId: "first" })).resolves.toEqual({});
    expect(firstSignal?.aborted).toBe(true);
    await expectError(readBlock(socket, "first", 0, 1), -32004);
    await expectError(openFile(socket, "first"), -32600);
    const second = openFile(socket, "second");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await expect(rpc(socket, "fs/close", { handleId: "second" })).resolves.toEqual({});
    expect(readFile.mock.calls[1]?.[0].signal?.aborted).toBe(true);
    await expectError(
      openFile(socket, "overflow"),
      -32600,
      "sandbox file read exceeds the per-connection buffered file limit",
    );
    expect(readFile).toHaveBeenCalledTimes(2);
    const firstSettled = expect(first).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await firstSettled;
    const secondSettled = expect(second).rejects.toMatchObject({ code: -32004 });
    releaseReads.get("/workspace/second.txt")?.(Buffer.from("second"));
    await secondSettled;
    const recovered = openFile(socket, "first");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(3));
    releaseReads.get("/workspace/first.txt")?.(Buffer.from("first"));
    await expect(recovered).resolves.toEqual({ handleId: "first" });
  });

  it("aborts pending reads and never starts new sandbox reads after socket disconnect", async () => {
    const { run: readFile, releases: reads } = pendingIo<Buffer>();
    const { run: pendingStat, releases: stats } = pendingIo<ReturnType<typeof fileStat>>();
    const stat = vi.fn(({ filePath }: { filePath: string }) => {
      if (filePath.endsWith("stat-pending.txt")) {
        return pendingStat({ filePath });
      }
      return Promise.resolve({ type: "file" as const, size: 5, mtimeMs: 1 });
    });
    const socket = await connect({ readFile, stat });

    sendOpen(socket, 1, "pending", "file:///workspace/pending.txt");
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    const signal = readFile.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    sendOpen(socket, 2, "stat-pending", "file:///workspace/stat-pending.txt");
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(2));
    const disconnected = waitForSocketClose(socket);
    socket.close();
    await disconnected;
    // The client can close before the server observes and cancels the peer connection.
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    stats.get("/workspace/stat-pending.txt")?.(fileStat(5));
    reads.get("/workspace/pending.txt")?.(Buffer.from("small"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
