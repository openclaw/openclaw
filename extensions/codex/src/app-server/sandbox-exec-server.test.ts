// Codex tests cover sandbox exec server plugin behavior.
import { useIsolatedStateGuard, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { sendResult } from "./sandbox-exec-server/json-rpc.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES = 100 * 1024 * 1024;
import {
  collectNotifications,
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  readUntilClosed,
  rpc,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

useIsolatedStateGuard();

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

function testExecEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
  };
}

async function readStartedPid(
  socket: Awaited<ReturnType<typeof openSocket>>,
  processId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = (await rpc(socket, "process/read", {
      processId,
      afterSeq: 0,
      waitMs: 100,
    })) as { chunks?: Array<{ chunk: string }> };
    const output = (read.chunks ?? [])
      .map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8"))
      .join("");
    const pid = /PID=(\d+)/u.exec(output)?.[1];
    if (pid) {
      return Number(pid);
    }
  }
  throw new Error(`process ${processId} did not report its PID`);
}

async function openSandboxSocket(sandbox: ReturnType<typeof createSandboxContext>) {
  const client = createClient();
  await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
  const socket = await openSocket(execServerUrlFromClient(client));
  await rpc(socket, "initialize", { clientName: "test" });
  socket.send(JSON.stringify({ method: "initialized" }));
  return socket;
}

describe("OpenClaw Codex sandbox exec-server", () => {
  it("rejects an incomplete sandbox environment before publishing an exec-server", async () => {
    const sandbox = createSandboxContext({});
    sandbox.fsBridge = undefined;
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox }),
    ).rejects.toThrow("Sandbox filesystem bridge is unavailable.");
    expect(client.request).not.toHaveBeenCalled();
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
  });

  it("reports target shell, encoded workdir, and readiness", async () => {
    const sandbox = createSandboxContext({});
    sandbox.containerWorkdir = "/workspace/space #project";
    const socket = await openSandboxSocket(sandbox);

    await expect(rpc(socket, "environment/info", {})).resolves.toEqual({
      shell: { name: "sh", path: "/bin/sh" },
      cwd: "file:///workspace/space%20%23project",
      capabilities: { networkProxyLaunch: false },
    });
    await expect(rpc(socket, "environment/status", {})).resolves.toEqual({ status: "ready" });
    socket.close();
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

  it("registers a sandbox-backed Codex environment and routes process execution through it", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", "process.stdout.write('sandbox-process-ok\\n')"],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      getServerVersion: vi.fn(() => CODEX_APP_SERVER_VERSION),
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
      cwd: "file:///projects/example%20repo",
      env: {
        POLICY_SET: "env-wins",
        TEST_FLAG: "1",
        CODEX_API_KEY: "must-not-cross",
        OPENAI_API_KEY: "must-not-cross",
      },
      envPolicy: {
        inherit: "none",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: {
          POLICY_SET: "policy",
          POLICY_ONLY: "1",
          CODEX_ACCESS_TOKEN: "must-not-cross",
        },
        includeOnly: [],
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
    })) as { processId?: string; nextSeq?: number };
    expect(start).toEqual({ processId: "proc-1", sandboxType: "none" });
    const read = await readUntilClosed(socket, "proc-1");

    expect(read.exited).toBe(true);
    expect(read.exitCode).toBe(0);
    expect(read.closed).toBe(true);
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "sandbox-process-ok\n",
    );
    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_SANDBOX_EXEC_ID: expect.any(String),
          POLICY_ONLY: "1",
          POLICY_SET: "env-wins",
          TEST_FLAG: "1",
        }),
        usePty: false,
        workdir: "/projects/example repo",
      }),
    );
    expect(notifications.map((notification) => notification.method)).toEqual(
      expect.arrayContaining(["process/output", "process/exited", "process/closed"]),
    );
    socket.close();
  });

  it.each([
    ["a relative path", "workspace"],
    ["a non-file scheme", "https://example.test/workspace"],
    ["a remote file authority", "file://remote.example.test/workspace"],
    ["a fragment", "file:///workspace#section"],
    ["an encoded Windows drive path", "file:///%43:/workspace"],
    ["an encoded null byte", "file:///workspace%00"],
  ])("rejects a process cwd with %s", async (_label, cwd) => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "process/start", {
        processId: "proc-invalid-cwd",
        argv: ["/usr/bin/pwd"],
        cwd,
        env: {},
        tty: false,
        pipeStdin: false,
        arg0: null,
      }),
    ).rejects.toThrow(/process cwd/u);
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it("closes oversized sandbox exec-server frames before JSON-RPC parsing", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const closed = waitForSocketClose(socket);

    socket.send(Buffer.alloc(CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES + 1));

    await expect(closed).resolves.toEqual({ code: 1009 });
  });

  it("rejects unsupported arg0 overrides instead of dropping them", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const socket = await openSandboxSocket(sandbox);

    await expect(
      rpc(socket, "process/start", {
        processId: "proc-arg0",
        argv: ["/bin/sh", "-lc", "true"],
        cwd: "file:///workspace",
        env: {},
        tty: false,
        pipeStdin: false,
        arg0: "codex-linux-sandbox",
      }),
    ).rejects.toThrow("does not support arg0 overrides");
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it.each([
    {
      description: "managed per-process filesystem restrictions",
      restrictions: {
        sandbox: codexFsSandboxContext({
          entries: [
            {
              path: { type: "path", path: "file:///workspace/allowed" },
              access: "read",
            },
          ],
        }),
      },
      error: /filesystem sandbox.*cannot be enforced/iu,
    },
    {
      description: "required managed networking without enforcement details",
      restrictions: { enforceManagedNetwork: true },
      error: /managed network.*cannot be enforced/iu,
    },
    {
      description: "an executor-local managed network proxy",
      restrictions: { networkProxy: { policyDecisionTimeoutMs: 1_000 } },
      error: /network proxy.*not supported/iu,
    },
    {
      description: "restricted managed network access in an SSH sandbox",
      restrictions: {
        sandbox: {
          permissions: {
            type: "managed",
            file_system: { type: "unrestricted" },
            network: "restricted",
          },
        },
      },
      backendId: "ssh",
      error: /network restrictions.*cannot be enforced/iu,
    },
    {
      description: "network isolation claimed after a network-enabled container started",
      restrictions: {
        sandbox: { permissions: { type: "external", network: "restricted" } },
      },
      backendNetwork: "bridge",
      networkAfterStartup: "none",
      error: /network restrictions.*cannot be enforced/iu,
    },
  ])(
    "rejects $description before launching a process",
    async ({ restrictions, error, backendNetwork, backendId, networkAfterStartup }) => {
      const buildExecSpec = vi.fn(async () => ({
        argv: [process.execPath, "-e", ""],
        env: testExecEnv(),
        stdinMode: "pipe-closed" as const,
      }));
      const sandbox = createSandboxContext({ buildExecSpec });
      if (backendNetwork) {
        sandbox.docker.network = backendNetwork;
      }
      if (backendId) {
        sandbox.backendId = backendId;
        if (sandbox.backend) {
          sandbox.backend.id = backendId;
        }
      }
      const client = createClient();
      await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
      if (networkAfterStartup) {
        sandbox.docker.network = networkAfterStartup;
      }
      const socket = await openSocket(execServerUrlFromClient(client));
      await rpc(socket, "initialize", { clientName: "test" });

      await expect(
        rpc(socket, "process/start", {
          processId: "proc-unsupported-sandbox",
          argv: ["/bin/sh", "-lc", "true"],
          cwd: "file:///workspace",
          env: {},
          tty: false,
          pipeStdin: false,
          arg0: null,
          ...restrictions,
        }),
      ).rejects.toThrow(error);
      expect(buildExecSpec).not.toHaveBeenCalled();
      socket.close();
    },
  );

  it.each([
    {
      description: "unrestricted managed filesystem access",
      sandbox: {
        permissions: {
          type: "managed",
          file_system: { type: "unrestricted" },
          network: "enabled",
        },
      },
    },
    {
      description: "network restrictions already enforced by a Podman container",
      sandbox: { permissions: { type: "external", network: "restricted" } },
      backendId: "podman",
    },
  ])(
    "preserves $description and reports its actual sandbox type",
    async ({ sandbox: policy, backendId }) => {
      const buildExecSpec = vi.fn(async () => ({
        argv: [process.execPath, "-e", ""],
        env: testExecEnv(),
        stdinMode: "pipe-closed" as const,
      }));
      const sandbox = createSandboxContext({ buildExecSpec });
      if (backendId) {
        sandbox.backendId = backendId;
        if (sandbox.backend) {
          sandbox.backend.id = backendId;
        }
      }
      const client = createClient();
      await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
      const socket = await openSocket(execServerUrlFromClient(client));
      await rpc(socket, "initialize", { clientName: "test" });

      await expect(
        rpc(socket, "process/start", {
          processId: "proc-external-sandbox",
          argv: ["/bin/sh", "-lc", "true"],
          cwd: "file:///workspace",
          env: {},
          tty: false,
          pipeStdin: false,
          arg0: null,
          ...(policy ? { sandbox: policy } : {}),
        }),
      ).resolves.toEqual({ processId: "proc-external-sandbox", sandboxType: "none" });
      expect(buildExecSpec).toHaveBeenCalledOnce();
      socket.close();
    },
  );

  it.runIf(process.platform !== "win32")(
    "provides a real terminal and Ctrl-C for tty processes",
    async () => {
      const buildExecSpec = vi.fn(async () => ({
        argv: [
          process.execPath,
          "-e",
          [
            "process.on('SIGINT', () => { console.log('INTERRUPTED'); process.exit(42); });",
            "console.log('PID=' + process.pid + ' TTY=' + Boolean(process.stdin.isTTY && process.stdout.isTTY));",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        env: testExecEnv(),
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
        cwd: "file:///workspace",
        env: {},
        tty: true,
        pipeStdin: false,
        arg0: null,
      });
      await readStartedPid(socket, "proc-tty");
      const initial = (await rpc(socket, "process/read", {
        processId: "proc-tty",
        afterSeq: 0,
      })) as {
        chunks: Array<{ chunk: string }>;
      };
      expect(
        initial.chunks.map(({ chunk }) => Buffer.from(chunk, "base64").toString()).join(""),
      ).toContain("TTY=true");
      await expect(
        rpc(socket, "process/write", {
          processId: "proc-tty",
          chunk: Buffer.from("\u0003").toString("base64"),
        }),
      ).resolves.toEqual({ status: "accepted" });
      const read = await readUntilClosed(socket, "proc-tty");

      expect(buildExecSpec).toHaveBeenCalledWith(expect.objectContaining({ usePty: true }));
      expect(read.chunks?.[0]?.stream).toBe("pty");
      expect(
        read.chunks?.map(({ chunk }) => Buffer.from(chunk, "base64").toString()).join(""),
      ).toContain("INTERRUPTED");
      expect(read.exitCode).toBe(42);
      socket.close();
    },
  );

  it("does not let Codex env policy inherit host secret variables", async () => {
    await withEnvAsync(
      {
        OPENCLAW_TEST_SECRET_TOKEN: "host-secret",
        OPENCLAW_TEST_DATABASE_PASSWORD: "host-password",
        OPENCLAW_TEST_PRIVATE_KEY: "host-private-key",
      },
      async () => {
        const buildExecSpec = vi.fn(async () => ({
          argv: [process.execPath, "-e", ""],
          env: {},
          stdinMode: "pipe-closed" as const,
        }));
        const sandbox = createSandboxContext({ buildExecSpec });
        const socket = await openSandboxSocket(sandbox);

        await rpc(socket, "process/start", {
          processId: "proc-secret-env",
          argv: ["/bin/sh", "-lc", "true"],
          cwd: "file:///workspace",
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

        const [{ env: execEnv }] = buildExecSpec.mock.calls[0] as unknown as [
          { env: Record<string, string> },
        ];
        expect(execEnv).toEqual({ CODEX_SANDBOX_EXEC_ID: expect.any(String) });
        socket.close();
      },
    );
  });

  it("keeps process/read cursors at the last returned byte-limited chunk", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('aaaa'); process.stderr.write('bbbb');",
        ],
        env: testExecEnv(),
        stdinMode: "pipe-closed",
      }),
    });
    const socket = await openSandboxSocket(sandbox);

    await rpc(socket, "process/start", {
      processId: "proc-cursor",
      argv: [process.execPath, "-e", "ignored"],
      cwd: "file:///workspace",
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
    const socket = await openSandboxSocket(sandbox);

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

  it("distinguishes unsupported exec methods from missing filesystem resources", async () => {
    const sandbox = createSandboxContext({ stat: async () => null });
    const socket = await openSandboxSocket(sandbox);

    for (const method of ["fs/walk", "unsupported/method"]) {
      await expect(rpc(socket, method, {})).rejects.toMatchObject({
        code: -32601,
        message: `Unsupported OpenClaw sandbox exec-server method: ${method}`,
      });
    }
    await expect(
      rpc(socket, "fs/getMetadata", { path: "file:///workspace/missing" }),
    ).rejects.toMatchObject({
      code: -32004,
      message: "file not found",
    });
    await expect(rpc(socket, "environment/status", {})).resolves.toEqual({
      status: "ready",
    });

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

  it.runIf(process.platform !== "win32")(
    "reaps TERM-resistant process groups on socket loss and turn environment release",
    async () => {
      for (const cleanup of ["socket", "environment"] as const) {
        const finalizeExec = vi.fn(async () => undefined);
        const sandbox = createSandboxContext({
          buildExecSpec: async () => ({
            argv: [
              "/bin/sh",
              "-c",
              'echo "PID=$$"; trap -- "" TERM; while :; do echo heartbeat; sleep 0.1; done',
            ],
            env: testExecEnv(),
            finalizeToken: `${cleanup}-lease`,
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        });
        sandbox.runtimeId = `openclaw-test-runtime-${cleanup}`;
        const client = createClient();
        await ensureCodexSandboxExecServerEnvironment({
          client: client as never,
          sandbox,
        });
        const socket = await openSocket(execServerUrlFromClient(client));
        let pid: number | undefined;
        try {
          await rpc(socket, "initialize", { clientName: "test" });
          socket.send(JSON.stringify({ method: "initialized" }));
          await rpc(socket, "process/start", {
            processId: `process-${cleanup}`,
            argv: ["ignored"],
            cwd: "file:///workspace",
            env: {},
            tty: false,
            pipeStdin: false,
            arg0: null,
          });
          pid = await readStartedPid(socket, `process-${cleanup}`);

          if (cleanup === "socket") {
            const closed = waitForSocketClose(socket);
            socket.terminate();
            await closed;
            await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce(), {
              timeout: 3_000,
            });
          } else {
            await releaseCodexSandboxExecServerEnvironment(sandbox);
            await expect(openSocket(execServerUrlFromClient(client))).rejects.toThrow();
          }

          expect(() => process.kill(pid!, 0)).toThrow();
          expect(finalizeExec).toHaveBeenCalledOnce();
          expect(finalizeExec).toHaveBeenCalledWith({
            status: "completed",
            exitCode: 1,
            timedOut: false,
            token: `${cleanup}-lease`,
          });
        } finally {
          if (pid) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // The owner already reaped the process group.
            }
          }
          await releaseCodexSandboxExecServerEnvironment(sandbox);
        }
      }
    },
  );

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
});

describe("Codex sandbox command identity", () => {
  it.runIf(process.platform !== "win32")(
    "preserves literal argv process identity and exit status through a shell backend",
    async () => {
      const sandbox = createSandboxContext({
        buildExecSpec: async ({ command, env }) => ({
          argv: [
            "/bin/sh",
            "-c",
            // Prevent implicit shell exec optimization, which otherwise hides the extra process.
            `export BACKEND_EXEC_PID=$$; trap 'printf "BACKEND_EXIT\\n"; exit 99' EXIT; ${command}`,
          ],
          env: { ...env, PATH: process.env.PATH },
          stdinMode: "pipe-closed",
        }),
      });
      const client = createClient();
      await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
      const socket = await openSocket(execServerUrlFromClient(client));
      try {
        await rpc(socket, "initialize", { clientName: "command-identity-test" });
        socket.send(JSON.stringify({ method: "initialized" }));
        await rpc(socket, "process/start", {
          processId: "literal-command",
          argv: [
            process.execPath,
            "-e",
            "console.log(process.pid + ':' + process.env.BACKEND_EXEC_PID); process.exit(42)",
          ],
          cwd: "file:///workspace",
          env: {},
          tty: false,
        });
        const read = await readUntilClosed(socket, "literal-command");
        expect(read).toMatchObject({ exited: true, closed: true, exitCode: 42 });
        const output = (read.chunks ?? [])
          .map(({ chunk }) => Buffer.from(chunk, "base64").toString("utf8"))
          .join("");
        expect(output).toMatch(/^\d+:\d+\n$/u);
        const [pid, backendPid] = output.trim().split(":").map(Number);
        expect(pid).toBeGreaterThan(0);
        expect(pid).toBe(backendPid);
      } finally {
        socket.close();
      }
    },
  );
});

describe("sandbox exec-server JSON-RPC helpers", () => {
  it("preserves explicit null results", () => {
    const send = vi.fn();

    sendResult(send, 1, null);

    expect(send).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 1, result: null });
  });
});
