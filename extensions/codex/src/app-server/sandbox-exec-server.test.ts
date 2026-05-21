import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  closeCodexSandboxExecServersForTests,
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";

type RpcResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeCodexSandboxExecServersForTests();
});

describe("OpenClaw Codex sandbox exec-server", () => {
  it("reports unavailable app-server remote environment support without exposing an environment", async () => {
    const sandbox = createSandboxContext({});
    const client = {
      getServerVersion: vi.fn(() => "0.132.0"),
      request: vi.fn(async () => {
        throw new Error("unknown variant environment/add");
      }),
    };

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not advertise a local exec-server URL to remote app-servers", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: {
          transport: "websocket",
          command: "codex",
          commandSource: "config",
          args: [],
          url: "wss://codex.example.test/app-server",
          headers: {},
        },
      }),
    ).rejects.toThrow("cannot be registered with a remote Codex app-server");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not treat 127-prefixed DNS names as local app-server hosts", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: {
          transport: "websocket",
          command: "codex",
          commandSource: "config",
          args: [],
          url: "wss://127.example.test/app-server",
          headers: {},
        },
      }),
    ).rejects.toThrow("cannot be registered with a remote Codex app-server");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects Codex app-server versions before the sandbox exec-server environment contract", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient({ serverVersion: "0.131.0" });

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
      }),
    ).rejects.toThrow("Codex app-server 0.132.0 or newer is required");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("registers a sandbox-backed Codex environment and routes process execution through it", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "printf 'sandbox-process-ok\\n'"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      getServerVersion: vi.fn(() => "0.132.0"),
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }),
    };

    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const addRequest = requests[0];
    expect(addRequest?.method).toBe("environment/add");
    expect(environment).toEqual({
      environmentId: expect.stringMatching(/^openclaw-sandbox-/),
      cwd: "/workspace",
    });
    const execServerUrl =
      typeof addRequest?.params === "object" &&
      addRequest.params &&
      "execServerUrl" in addRequest.params
        ? String(addRequest.params.execServerUrl)
        : "";
    expect(execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);

    const socket = await openSocket(execServerUrl);
    const notifications = collectNotifications(socket);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
    const start = (await rpc(socket, "process/start", {
      processId: "proc-1",
      argv: ["/bin/sh", "-lc", "printf ok"],
      cwd: "/workspace",
      env: { POLICY_SET: "env-wins", TEST_FLAG: "1" },
      envPolicy: {
        inherit: "none",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: { POLICY_SET: "policy", POLICY_ONLY: "1" },
        includeOnly: [],
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
    })) as { processId?: string; nextSeq?: number };
    expect(start).toEqual({ processId: "proc-1" });
    const read = await readUntilClosed(socket, "proc-1");

    expect(read.exited).toBe(true);
    expect(read.exitCode).toBe(0);
    expect(read.closed).toBe(true);
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "sandbox-process-ok\n",
    );
    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "'/bin/sh' '-lc' 'printf ok'",
        env: { POLICY_ONLY: "1", POLICY_SET: "env-wins", TEST_FLAG: "1" },
        usePty: false,
        workdir: "/workspace",
      }),
    );
    expect(notifications.map((notification) => notification.method)).toEqual(
      expect.arrayContaining(["process/output", "process/exited", "process/closed"]),
    );
    socket.close();
  });

  it("accepts stdin writes for pipe-backed processes", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["/bin/sh", "-lc", 'read line; printf "echo:%s\\n" "$line"'],
        env: process.env,
        stdinMode: "pipe-open",
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

    await rpc(socket, "process/start", {
      processId: "proc-stdin",
      argv: ["/bin/sh", "-lc", "cat"],
      cwd: "/workspace",
      env: {},
      tty: false,
      pipeStdin: true,
      arg0: null,
    });
    await expect(
      rpc(socket, "process/write", {
        processId: "proc-stdin",
        chunk: Buffer.from("hello\n").toString("base64"),
      }),
    ).resolves.toEqual({ status: "accepted" });
    const read = await readUntilClosed(socket, "proc-stdin");
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "echo:hello\n",
    );
    socket.close();
  });

  it("keeps tty process starts pipe-backed for sandbox backends", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", 'read line; printf "tty:%s\\n" "$line"'],
      env: process.env,
      stdinMode: "pipe-open" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-tty",
      argv: ["/bin/sh", "-lc", "cat"],
      cwd: "/workspace",
      env: {},
      tty: true,
      pipeStdin: false,
      arg0: null,
    });
    await expect(
      rpc(socket, "process/write", {
        processId: "proc-tty",
        chunk: Buffer.from("hello\n").toString("base64"),
      }),
    ).resolves.toEqual({ status: "accepted" });
    const read = await readUntilClosed(socket, "proc-tty");

    expect(buildExecSpec).toHaveBeenCalledWith(expect.objectContaining({ usePty: false }));
    expect(read.chunks?.[0]?.stream).toBe("pty");
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "tty:hello\n",
    );
    socket.close();
  });

  it("does not let Codex env policy inherit host secret variables", async () => {
    vi.stubEnv("HOME", "/gateway-home");
    vi.stubEnv("USER", "gateway-user");
    vi.stubEnv("TMPDIR", "/gateway-tmp");
    vi.stubEnv("OPENCLAW_TEST_SECRET_TOKEN", "host-secret");
    vi.stubEnv("OPENCLAW_TEST_DATABASE_PASSWORD", "host-password");
    vi.stubEnv("OPENCLAW_TEST_PRIVATE_KEY", "host-private-key");
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "true"],
      env: {},
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-secret-env",
      argv: ["/bin/sh", "-lc", "true"],
      cwd: "/workspace",
      env: {},
      envPolicy: {
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: {},
        includeOnly: [],
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
    });

    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
      }),
    );
    socket.close();
  });

  it("keeps process/read cursors at the last returned byte-limited chunk", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('aaaa'); process.stderr.write('bbbb');",
        ],
        env: process.env,
        stdinMode: "pipe-closed",
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

    await rpc(socket, "process/start", {
      processId: "proc-cursor",
      argv: [process.execPath, "-e", "ignored"],
      cwd: "/workspace",
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    const complete = await readUntilClosed(socket, "proc-cursor");
    expect(complete.chunks?.length ?? 0).toBeGreaterThanOrEqual(2);

    const firstRead = (await rpc(socket, "process/read", {
      processId: "proc-cursor",
      afterSeq: 0,
      maxBytes: 4,
    })) as { chunks?: Array<{ seq: number }>; nextSeq?: number };
    expect(firstRead.chunks).toHaveLength(1);
    expect(firstRead.nextSeq).toBe((firstRead.chunks?.[0]?.seq ?? 0) + 1);
    expect(firstRead.nextSeq ?? 0).toBeLessThan(complete.nextSeq ?? 0);

    const secondRead = (await rpc(socket, "process/read", {
      processId: "proc-cursor",
      afterSeq: (firstRead.nextSeq ?? 1) - 1,
      maxBytes: 4,
    })) as { chunks?: Array<{ seq: number }> };
    expect(secondRead.chunks?.length ?? 0).toBeGreaterThanOrEqual(1);
    socket.close();
  });

  it("returns protocol statuses for unsupported process writes and unknown termination", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "process/write", {
        processId: "missing",
        chunk: Buffer.from("hello").toString("base64"),
      }),
    ).resolves.toEqual({ status: "unknownProcess" });
    await expect(
      rpc(socket, "process/terminate", {
        processId: "missing",
      }),
    ).resolves.toEqual({ running: false });
    socket.close();
  });

  it("rejects WebSocket clients that do not know the exec-server capability path", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const unauthorizedUrl = execServerUrlFromClient(client).replace(
      /\/openclaw-[^/?#]+/u,
      "/wrong",
    );
    const socket = await openSocket(unauthorizedUrl);

    await expect(waitForSocketClose(socket)).resolves.toEqual({ code: 1008 });
  });

  it("closes the exec-server when its sandbox environment is released", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const execServerUrl = execServerUrlFromClient(client);
    await releaseCodexSandboxExecServerEnvironment(sandbox);

    await expect(openSocket(execServerUrl)).rejects.toThrow();
  });

  it("keeps a shared exec-server open when another turn reacquires during release", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const firstExecServerUrl = execServerUrlFromClient(client);

    const release = releaseCodexSandboxExecServerEnvironment(sandbox);
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    await release;
    const secondExecServerUrl = execServerUrlFromClient(client, 1);

    expect(secondExecServerUrl).toBe(firstExecServerUrl);
    const socket = await openSocket(secondExecServerUrl);
    await expect(rpc(socket, "initialize", { clientName: "test" })).resolves.toEqual({
      sessionId: expect.any(String),
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
      path: "/workspace/note.txt",
      dataBase64: Buffer.from("hello").toString("base64"),
    });
    await rpc(socket, "fs/writeFile", {
      path: "/workspace/empty.txt",
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
        path: "/workspace/missing/note.txt",
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
        path: "/workspace/read-only.txt",
        dataBase64: Buffer.from("blocked").toString("base64"),
        sandbox: codexFsSandboxContext({
          entries: [{ path: specialPath("root"), access: "read" }],
        }),
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");
    await rpc(socket, "fs/writeFile", {
      path: "/workspace/allowed.txt",
      dataBase64: Buffer.from("allowed").toString("base64"),
      sandbox: codexFsSandboxContext({
        entries: [
          { path: specialPath("root"), access: "read" },
          { path: specialPath("project_roots"), access: "write" },
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
        path: "/workspace/.git/config",
        dataBase64: Buffer.from("blocked").toString("base64"),
        sandbox: workspacePolicy,
      }),
    ).rejects.toThrow("Codex fs sandbox denied write access");
    await expect(
      rpc(socket, "fs/remove", {
        path: "/workspace",
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
        path: "/workspace/private/secret.txt",
        sandbox: policy,
      }),
    ).rejects.toThrow("Codex fs sandbox denied read access");
    await expect(
      rpc(socket, "fs/readFile", {
        path: "/workspace/key.pem",
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
        path: "/workspace/KEY.PEM",
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
      path: "/workspace/private/nested/allowed.txt",
      dataBase64: Buffer.from("ok").toString("base64"),
      sandbox: policy,
    });
    await expect(
      rpc(socket, "fs/remove", {
        path: "/workspace/private",
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
      path: "/workspace/allowed.txt",
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
        path: "/workspace/key.pem",
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
        path: "/workspace/src",
        recursive: true,
        force: true,
        sandbox: policy,
      }),
    ).rejects.toThrow("because /workspace/**/*.pem is not writable");

    expect(remove).not.toHaveBeenCalled();
    socket.close();
  });

  it("routes recursive copies through the sandbox filesystem bridge", async () => {
    const mkdirp = vi.fn(async () => undefined);
    const readFile = vi.fn(async ({ filePath }: { filePath: string }) =>
      Buffer.from(`data:${filePath}`),
    );
    const writeFile = vi.fn(async () => undefined);
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
      mkdirp,
      readFile,
      runShellCommand,
      stat: async ({ filePath }) => ({
        type: filePath.endsWith("source-dir") || filePath.endsWith("subdir") ? "directory" : "file",
        size: 1,
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
      sourcePath: "/workspace/source-dir",
      destinationPath: "/workspace/destination-dir",
      recursive: true,
    });

    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/destination-dir" });
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/destination-dir/subdir" });
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/destination-dir/file.txt",
      data: Buffer.from("data:/workspace/source-dir/file.txt"),
      mkdir: true,
    });
    expect(writeFile).toHaveBeenCalledWith({
      filePath: "/workspace/destination-dir/subdir/nested.txt",
      data: Buffer.from("data:/workspace/source-dir/subdir/nested.txt"),
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
        sourcePath: "/workspace/source-dir",
        destinationPath: "/workspace/source-dir/backup",
        recursive: true,
      }),
    ).rejects.toThrow("Cannot recursively copy a directory into itself");

    expect(mkdirp).not.toHaveBeenCalled();
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

    await expect(rpc(socket, "fs/getMetadata", { path: "/workspace/missing" })).rejects.toThrow(
      "file not found",
    );
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

    await expect(rpc(socket, "fs/readFile", { path: "/workspace/huge.bin" })).rejects.toThrow(
      "file is too large to read through Codex sandbox exec-server",
    );

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
        path: "/workspace/missing/child",
        recursive: false,
      }),
    ).rejects.toThrow("parent directory not found");
    expect(mkdirp).not.toHaveBeenCalled();

    await rpc(socket, "fs/createDirectory", {
      path: "/workspace/existing/child",
      recursive: false,
    });
    expect(mkdirp).toHaveBeenCalledWith({ filePath: "/workspace/existing/child" });
    socket.close();
  });

  it("routes HTTP requests through the sandbox backend", async () => {
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.from(
        JSON.stringify({
          status: 201,
          headers: [{ name: "content-type", value: "text/plain" }],
          bodyBase64: Buffer.from("sandbox-http").toString("base64"),
        }),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({ runShellCommand });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-1",
        method: "POST",
        url: "https://example.test/mcp",
        headers: [{ name: "authorization", value: "Bearer test" }],
        bodyBase64: Buffer.from("body").toString("base64"),
      }),
    ).resolves.toEqual({
      status: 201,
      headers: [{ name: "content-type", value: "text/plain" }],
      bodyBase64: Buffer.from("sandbox-http").toString("base64"),
    });
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        stdin: expect.stringContaining("https://example.test/mcp"),
      }),
    );
    socket.close();
  });

  it("streams HTTP response body deltas from the sandbox backend", async () => {
    const headerLine = JSON.stringify({
      type: "headers",
      status: 202,
      headers: [{ name: "content-type", value: "text/event-stream" }],
    });
    const bodyLine = JSON.stringify({
      type: "bodyDelta",
      seq: 1,
      deltaBase64: Buffer.from("event: ok\n\n").toString("base64"),
      done: false,
    });
    const doneLine = JSON.stringify({
      type: "bodyDelta",
      seq: 2,
      deltaBase64: "",
      done: true,
    });
    const buildExecSpec = vi.fn(async () => ({
      argv: [
        "/bin/sh",
        "-lc",
        [headerLine, bodyLine, doneLine]
          .map((line) => `printf '%s\\n' ${shellQuote(line)}`)
          .join("; "),
      ],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({ buildExecSpec, runShellCommand });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const notifications = collectNotifications(socket);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-stream",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({
      status: 202,
      headers: [{ name: "content-type", value: "text/event-stream" }],
      bodyBase64: "",
    });
    const deltas = await waitForHttpBodyDeltas(notifications, 2);

    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("python3"),
        usePty: false,
        workdir: "/workspace",
      }),
    );
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(deltas).toEqual([
      expect.objectContaining({
        requestId: "http-stream",
        seq: 1,
        deltaBase64: Buffer.from("event: ok\n\n").toString("base64"),
        done: false,
      }),
      expect.objectContaining({
        requestId: "http-stream",
        seq: 2,
        deltaBase64: "",
        done: true,
      }),
    ]);
    socket.close();
  });

  it("terminates streaming HTTP subprocesses when the exec-server socket closes", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          [
            "process.on('SIGTERM', () => process.exit(143));",
            `console.log(${JSON.stringify(
              JSON.stringify({
                type: "headers",
                status: 200,
                headers: [],
              }),
            )});`,
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        env: process.env,
        finalizeToken: "stream-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
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
      rpc(socket, "http/request", {
        requestId: "http-stream-close",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({
      status: 200,
      headers: [],
      bodyBase64: "",
    });
    socket.terminate();

    await vi.waitFor(
      () =>
        expect(finalizeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "failed",
            token: "stream-token",
          }),
        ),
      { timeout: 5_000 },
    );
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
        path: "/outside/note.txt",
        dataBase64: Buffer.from("no").toString("base64"),
      }),
    ).rejects.toThrow("sandbox denied write outside workspace");
    socket.close();
  });
});

function createSandboxContext(overrides: {
  buildExecSpec?: NonNullable<SandboxContext["backend"]>["buildExecSpec"];
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  mkdirp?: NonNullable<SandboxContext["fsBridge"]>["mkdirp"];
  readFile?: NonNullable<SandboxContext["fsBridge"]>["readFile"];
  remove?: NonNullable<SandboxContext["fsBridge"]>["remove"];
  runShellCommand?: NonNullable<SandboxContext["backend"]>["runShellCommand"];
  stat?: NonNullable<SandboxContext["fsBridge"]>["stat"];
  writeFile?: NonNullable<SandboxContext["fsBridge"]>["writeFile"];
}): SandboxContext {
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "agent:codex:test",
    workspaceDir: "/host/workspace",
    agentWorkspaceDir: "/host/workspace",
    workspaceAccess: "rw",
    runtimeId: "openclaw-test-runtime",
    runtimeLabel: "openclaw-test-runtime",
    containerName: "openclaw-test-runtime",
    containerWorkdir: "/workspace",
    docker: { binds: [], image: "test", workdir: "/workspace", env: {}, network: "none" },
    tools: {},
    browserAllowHostControl: false,
    backend: {
      id: "docker",
      runtimeId: "openclaw-test-runtime",
      runtimeLabel: "openclaw-test-runtime",
      workdir: "/workspace",
      buildExecSpec:
        overrides.buildExecSpec ??
        (async () => ({
          argv: ["/bin/sh", "-lc", "true"],
          env: process.env,
          stdinMode: "pipe-closed",
        })),
      finalizeExec: overrides.finalizeExec,
      runShellCommand:
        overrides.runShellCommand ??
        (async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 })),
    },
    fsBridge: {
      resolvePath: ({
        filePath,
      }: Parameters<NonNullable<SandboxContext["fsBridge"]>["resolvePath"]>[0]) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      readFile: overrides.readFile ?? (async () => Buffer.alloc(0)),
      writeFile: overrides.writeFile ?? (async () => undefined),
      mkdirp: overrides.mkdirp ?? (async () => undefined),
      remove: overrides.remove ?? (async () => undefined),
      rename: async () => undefined,
      stat:
        overrides.stat ??
        (async ({ filePath }) => ({
          type: /\.[^/]+$/u.test(filePath) ? "file" : "directory",
          size: 1,
          mtimeMs: 1,
        })),
    },
  } as unknown as SandboxContext;
}

function createClient(options: { serverVersion?: string } = {}) {
  return {
    getServerVersion: vi.fn(() => options.serverVersion ?? "0.132.0"),
    request: vi.fn(async (_method: string, _params?: unknown) => ({})),
  };
}

function execServerUrlFromClient(client: ReturnType<typeof createClient>, callIndex = 0): string {
  const params = client.request.mock.calls[callIndex]?.[1];
  if (!params || typeof params !== "object" || !("execServerUrl" in params)) {
    throw new Error(`missing execServerUrl for environment/add call ${callIndex}`);
  }
  const { execServerUrl } = params as { execServerUrl?: unknown };
  if (typeof execServerUrl !== "string" || !execServerUrl) {
    throw new Error(`invalid execServerUrl for environment/add call ${callIndex}`);
  }
  return execServerUrl;
}

function codexFsSandboxContext(params: {
  entries: Array<{ path: unknown; access: "read" | "write" | "none" | "deny" }>;
  cwd?: string;
}): unknown {
  return {
    permissions: {
      type: "managed",
      file_system: {
        type: "restricted",
        entries: params.entries,
      },
      network: "restricted",
    },
    cwd: params.cwd ?? "/workspace",
    windowsSandboxLevel: "disabled",
    windowsSandboxPrivateDesktop: false,
    useLegacyLandlock: false,
  };
}

function specialPath(kind: string, subpath?: string): unknown {
  return {
    type: "special",
    value: {
      kind,
      ...(subpath ? { subpath } : {}),
    },
  };
}

function globPath(pattern: string): unknown {
  return {
    type: "glob_pattern",
    pattern,
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function collectNotifications(socket: WebSocket): Array<{ method: string; params?: unknown }> {
  const notifications: Array<{ method: string; params?: unknown }> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as {
      id?: number;
      method?: string;
      params?: unknown;
    };
    if (message.id === undefined && message.method) {
      notifications.push({ method: message.method, params: message.params });
    }
  });
  return notifications;
}

async function readUntilClosed(
  socket: WebSocket,
  processId: string,
): Promise<{
  chunks?: Array<{ stream: string; chunk: string }>;
  exited?: boolean;
  exitCode?: number;
  closed?: boolean;
  nextSeq?: number;
}> {
  let afterSeq = 0;
  const chunks: Array<{ stream: string; chunk: string }> = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = (await rpc(socket, "process/read", {
      processId,
      afterSeq,
      waitMs: 1000,
    })) as {
      chunks?: Array<{ seq?: number; stream: string; chunk: string }>;
      exited?: boolean;
      exitCode?: number;
      closed?: boolean;
      nextSeq?: number;
    };
    chunks.push(...(read.chunks ?? []));
    afterSeq = Math.max(afterSeq, (read.nextSeq ?? 1) - 1);
    if (read.closed) {
      return { ...read, chunks };
    }
  }
  throw new Error(`process ${processId} did not close`);
}

function waitForSocketClose(socket: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve({ code }));
  });
}

async function waitForHttpBodyDeltas(
  notifications: Array<{ method: string; params?: unknown }>,
  count: number,
): Promise<unknown[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const deltas = notifications
      .filter((notification) => notification.method === "http/request/bodyDelta")
      .map((notification) => notification.params);
    if (deltas.length >= count) {
      return deltas;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} http body deltas`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function rpc(socket: WebSocket, method: string, params: unknown): Promise<unknown> {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const response = JSON.parse(Buffer.from(data as Buffer).toString("utf8")) as RpcResponse;
      if (response.id !== id) {
        return;
      }
      socket.off("message", onMessage);
      if (response.error) {
        reject(new Error(response.error.message));
        return;
      }
      resolve(response.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
