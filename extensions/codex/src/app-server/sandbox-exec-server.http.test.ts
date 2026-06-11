// Codex tests cover sandbox exec server.http plugin behavior.
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeCodexSandboxExecServersForTests,
  ensureCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import {
  collectNotifications,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  rpc,
  waitForHttpBodyDeltas,
} from "./sandbox-exec-server.test-helpers.js";
import {
  SANDBOX_HTTP_REQUEST_SCRIPT,
  SANDBOX_HTTP_STREAM_LINE_MAX_CHARS,
} from "./sandbox-exec-server/http.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeCodexSandboxExecServersForTests();
});

function testExecEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
  };
}

function runSandboxHttpRequestScript(input: unknown): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", SANDBOX_HTTP_REQUEST_SCRIPT], {
      env: testExecEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr, stdout });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

describe("OpenClaw Codex sandbox exec-server HTTP", () => {
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

  it("blocks private HTTP targets before starting the sandbox backend", async () => {
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
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
        requestId: "http-private",
        method: "GET",
        url: "http://127.0.0.1:6379/",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal IP");
    expect(runShellCommand).not.toHaveBeenCalled();
    socket.close();
  });

  it("blocks metadata HTTP targets before starting the streaming sandbox backend", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
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

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-metadata",
        method: "GET",
        url: "http://metadata.google.internal/",
        streamResponse: true,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal IP");
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it("blocks protected IP classes inside the sandbox Python helper", async () => {
    const blockedUrls = [
      "http://100.100.100.200/",
      "http://[fd00:ec2::254]/",
      "http://[fec0::1]/",
      "http://[64:ff9b::100.100.100.200]/",
      "http://[64:ff9b:1::6464:64c8]/",
      "http://[2002:6464:64c8::]/",
      "http://[2001::9b9b:9b37]/",
      "http://[2001:4860:1::5efe:6464:64c8]/",
    ];

    for (const url of blockedUrls) {
      const result = await runSandboxHttpRequestScript({
        method: "GET",
        url,
        timeoutMs: 1,
      });
      expect(result.code, url).not.toBe(0);
      expect(result.stdout, url).toBe("");
      expect(result.stderr, url).toContain("Blocked");
    }
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
        process.execPath,
        "-e",
        [headerLine, bodyLine, doneLine]
          .map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
          .join(""),
      ],
      env: testExecEnv(),
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
        env: testExecEnv(),
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

  it("rejects streaming HTTP helpers that never terminate a stdout line", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          [
            `process.stdout.write("x".repeat(${SANDBOX_HTTP_STREAM_LINE_MAX_CHARS + 1}));`,
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        env: testExecEnv(),
        finalizeToken: "stream-line-token",
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
        requestId: "http-stream-long-line",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).rejects.toThrow("unterminated stdout line");

    await vi.waitFor(
      () =>
        expect(finalizeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "failed",
            token: "stream-line-token",
          }),
        ),
      { timeout: 5_000 },
    );
    socket.close();
  });
});
