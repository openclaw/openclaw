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
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

describe("OpenClaw Codex sandbox exec-server filesystem", () => {
  it("returns the required Codex file size in sandbox metadata", async () => {
    const sandbox = createSandboxContext({
      stat: async () => ({ type: "file", size: 1234, mtimeMs: 5678 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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

  it("routes file writes through the sandbox fs bridge", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ writeFile });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/note.txt",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/%65mpty.txt",
      dataBase64: "",
    });

    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/note.txt",
      data: Buffer.from("hello"),
      mkdir: false,
    });
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/empty.txt",
      data: Buffer.alloc(0),
      mkdir: false,
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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/missing/note.txt",
        dataBase64: Buffer.from("hello").toString("base64"),
      }),
    ).rejects.toThrow("parent directory not found");

    expect(writeFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("enforces Codex fs sandbox policy before mutating through the fs bridge", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ writeFile });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/read-only.txt",
        dataBase64: Buffer.from("blocked").toString("base64"),
        sandbox: codexFsSandboxContext({
          entries: [{ path: specialPath("root"), access: "read" }],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");
    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/allowed.txt",
      dataBase64: Buffer.from("allowed").toString("base64"),
      sandbox: codexFsSandboxContext({
        entries: [
          { path: specialPath("root"), access: "read" },
          { path: { type: "path", path: "file:///workspace" }, access: "write" },
        ],
      }),
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/allowed.txt",
      data: Buffer.from("allowed"),
      mkdir: false,
    });
    socket.close();
  });

  it("denies writes whose canonical destination is policy-protected", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      writeFile,
      // Simulates a workspace symlink alias that canonicalizes into .git.
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
      rpc(socket, "fs/writeFile", {
        path: "file:///workspace/alias/config",
        dataBase64: Buffer.from("blocked").toString("base64"),
        sandbox: codexFsSandboxContext({
          entries: [
            { path: specialPath("root"), access: "read" },
            { path: specialPath("project_roots"), access: "write" },
            { path: specialPath("project_roots", ".git"), access: "read" },
          ],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");

    expect(writeFile).not.toHaveBeenCalled();
    socket.close();
  });

  it("pins authorized writes to the canonical destination", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      writeFile,
      resolvePinnedMutationTarget: async ({ filePath }) =>
        filePath === "/workspace/alias/config"
          ? { policyPath: "/workspace/real/config", pinnedPath: "/workspace/real/config" }
          : { policyPath: filePath, pinnedPath: filePath },
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "fs/writeFile", {
      path: "file:///workspace/alias/config",
      dataBase64: Buffer.from("pinned").toString("base64"),
      sandbox: codexFsSandboxContext({
        entries: [
          { path: specialPath("root"), access: "read" },
          { path: specialPath("project_roots"), access: "write" },
        ],
      }),
    });

    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/alias/config",
      data: Buffer.from("pinned"),
      mkdir: false,
      pinnedPath: "/workspace/real/config",
    });
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

  it("pins authorized copies to the canonical destination", async () => {
    const copyFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      copyFile,
      stat: async () => ({ type: "file", size: 4, mtimeMs: 1 }),
      resolvePinnedMutationTarget: async ({ filePath }) =>
        filePath === "/workspace/alias/config"
          ? { policyPath: "/workspace/real/config", pinnedPath: "/workspace/real/config" }
          : { policyPath: filePath, pinnedPath: filePath },
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "fs/copy", {
      sourcePath: "file:///workspace/source.txt",
      destinationPath: "file:///workspace/alias/config",
      sandbox: codexFsSandboxContext({
        entries: [
          { path: specialPath("root"), access: "read" },
          { path: specialPath("project_roots"), access: "write" },
        ],
      }),
    });

    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/source.txt",
      destinationPath: "/workspace/alias/config",
      mkdir: true,
      pinnedPath: "/workspace/real/config",
    });
    socket.close();
  });

  it("honors Codex fs sandbox protected metadata carveouts", async () => {
    const remove = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ remove, writeFile });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
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

  it("ignores non-granting Codex fs sandbox special entries", async () => {
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({ writeFile });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
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
      stdout: Buffer.from("f\tfile.txt\nd\tsubdir\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    runShellCommand.mockImplementation(async (params?: { args?: string[] }) => ({
      stdout: Buffer.from(
        params?.args?.[0] === "/workspace/source-dir/subdir"
          ? "f\tnested.txt\n"
          : "f\tfile.txt\nd\tsubdir\n",
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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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

  it("streams oversized file copies through the fs bridge without buffering", async () => {
    const copyFile = vi.fn(async () => undefined);
    const readFile = vi.fn(async () => Buffer.from("too-large"));
    const writeFile = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      copyFile,
      readFile,
      stat: async () => ({
        type: "file",
        size: 512 * 1024 * 1024 + 1,
        mtimeMs: 1,
      }),
      writeFile,
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "fs/copy", {
      sourcePath: "file:///workspace/huge.bin",
      destinationPath: "file:///workspace/huge-copy.bin",
    });

    expect(copyFile).toHaveBeenCalledWith({
      sourcePath: "/workspace/huge.bin",
      destinationPath: "/workspace/huge-copy.bin",
      mkdir: true,
    });
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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

  it("rejects recursive directory copies into their own subtree", async () => {
    const mkdirp = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      mkdirp,
      stat: async () => ({
        type: "directory",
        size: 1,
        mtimeMs: 1,
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/copy", {
        sourcePath: "file:///workspace/source-dir",
        destinationPath: "file:///workspace/source-dir/backup",
        recursive: true,
      }),
    ).rejects.toThrow("Cannot recursively copy a directory into itself");

    expect(mkdirp).not.toHaveBeenCalled();
    socket.close();
  });

  it("rejects recursive directory copies into a canonical source subtree", async () => {
    const mkdirp = vi.fn(async () => undefined);
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.from("f\tchild.txt\n"),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({
      mkdirp,
      resolvePinnedMutationTarget: async ({ filePath }) => {
        if (filePath === "/workspace/source-dir") {
          return {
            policyPath: "/workspace/source-dir",
            pinnedPath: "/workspace/source-dir",
          };
        }
        if (filePath === "/workspace/alias") {
          return {
            policyPath: "/workspace/source-dir/subdir",
            pinnedPath: "/workspace/source-dir/subdir",
          };
        }
        return { policyPath: filePath, pinnedPath: filePath };
      },
      runShellCommand,
      stat: async () => ({
        type: "directory",
        size: 1,
        mtimeMs: 1,
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/copy", {
        sourcePath: "file:///workspace/source-dir",
        destinationPath: "file:///workspace/alias",
        recursive: true,
      }),
    ).rejects.toThrow("Cannot recursively copy a directory into itself");

    expect(mkdirp).not.toHaveBeenCalled();
    expect(runShellCommand).not.toHaveBeenCalled();
    socket.close();
  });

  it("reports missing metadata as an exec-server not found error", async () => {
    const sandbox = createSandboxContext({ stat: async () => null });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/getMetadata", { path: "file:///workspace/missing" }),
    ).rejects.toThrow("file not found");
    socket.close();
  });

  it("bounds legacy whole-file reads within the sandbox filesystem bridge", async () => {
    const data = Buffer.from("bounded legacy read");
    const readFile = vi.fn(async () => data);
    const sandbox = createSandboxContext({
      readFile,
      stat: async () => ({ type: "file", size: data.byteLength, mtimeMs: 1 }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

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

  it("surfaces sandbox bridge denials as exec-server errors", async () => {
    const sandbox = createSandboxContext({
      writeFile: async () => {
        throw new Error("sandbox denied write outside workspace");
      },
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "fs/writeFile", {
        path: "file:///outside/note.txt",
        dataBase64: Buffer.from("no").toString("base64"),
      }),
    ).rejects.toThrow("sandbox denied write outside workspace");
    socket.close();
  });
});
