import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  collectNotifications,
  createSandboxContext,
  openSandboxSocket,
  rpc,
  waitForHttpBodyDeltas,
} from "./sandbox-exec-server.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
const SANDBOX_HTTP_STREAM_LINE_MAX_CHARS = 256 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

function httpRpc(socket: Parameters<typeof rpc>[0], params: Record<string, unknown>) {
  return rpc(socket, "http/request", {
    requestId: "http",
    method: "GET",
    url: "https://example.test/sse",
    ...params,
  });
}

function openScriptHttpSocket(
  script: string,
  finalizeExec?: Parameters<typeof createSandboxContext>[0]["finalizeExec"],
) {
  return openSandboxSocket(
    createSandboxContext({
      buildExecSpec: async () => ({
        argv: [process.execPath, "-e", script],
        env: { PATH: process.env.PATH },
        ...(finalizeExec ? { finalizeToken: "stream-line-token" } : {}),
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    }),
  );
}

function expectBody(notifications: Parameters<typeof waitForHttpBodyDeltas>[0], body: string) {
  return expect(waitForHttpBodyDeltas(notifications, 2)).resolves.toEqual([
    expect.objectContaining({ deltaBase64: Buffer.from(body).toString("base64"), done: false }),
    expect.objectContaining({ deltaBase64: "", done: true }),
  ]);
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const header = (name: string, value: unknown) => expect.objectContaining({ name, value });

function splitUtf8ChildScript(stream: "stdout" | "stderr", headerLine: string): string {
  const target = `process.${stream}`;
  const value = stream === "stdout" ? headerLine : "sandbox failed: 猫 not found\n";
  const finish =
    stream === "stdout" ? `${target}.end(rest);` : `${target}.write(rest, () => process.exit(17));`;
  return [
    `const value = Buffer.from(${JSON.stringify(value)});`,
    'const marker = Buffer.from("猫");',
    "const splitAt = value.indexOf(marker) + 1;",
    ...(stream === "stderr" ? [`process.stdout.write(${JSON.stringify(headerLine)});`] : []),
    `${target}.write(value.subarray(0, splitAt));`,
    "setTimeout(() => {",
    "  const rest = value.subarray(splitAt);",
    `  ${finish}`,
    "}, 25);",
  ].join("\n");
}

async function createLiveRedirectSandbox(
  targetHost: "source.test" | "target.test" | "127.0.0.1" | "private.test",
  redirectStatus = 302,
  holdFinalResponse?: (response: ServerResponse) => void,
) {
  const requests: IncomingMessage[] = [];
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBodies.push(body);
      if (request.url === "/redirect") {
        response.writeHead(redirectStatus, {
          location: `http://${targetHost}:${port}/final`,
        });
        response.end("redirect body");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      if (holdFinalResponse) {
        response.flushHeaders();
        holdFinalResponse(response);
        return;
      }
      response.end("final body");
    });
  });
  const fixtureDir = tempDirs.make("codex-http-redirect-");
  await writeFile(
    join(fixtureDir, "sitecustomize.py"),
    String.raw`import socket
original_getaddrinfo = socket.getaddrinfo
original_connect = socket.socket.connect
def getaddrinfo(host, *args, **kwargs):
    if host in ("source.test", "target.test"):
        host = "93.184.216.34"
    elif host == "private.test":
        host = "127.0.0.1"
    return original_getaddrinfo(host, *args, **kwargs)
def connect(self, address):
    if isinstance(address, tuple) and address[0] == "93.184.216.34":
        address = ("127.0.0.1", *address[1:])
    return original_connect(self, address)
socket.getaddrinfo = getaddrinfo
socket.socket.connect = connect`,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const env = { PATH: process.env.PATH, PYTHONPATH: fixtureDir };
  const sandbox = createSandboxContext({
    runShellCommand: async ({ script, stdin }) => {
      const child = spawn("/bin/sh", ["-c", script], { env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end(stdin);
      const [code] = (await once(child, "close")) as [number];
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    },
    buildExecSpec: async ({ command }) => ({
      argv: ["/bin/sh", "-c", command],
      env,
      stdinMode: "pipe-closed",
    }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing live redirect test server address");
  }
  const port = address.port;
  const url = `http://source.test:${port}/redirect`;
  const socket = await openSandboxSocket(sandbox, !holdFinalResponse);
  return {
    socket,
    request: (params: Record<string, unknown> = {}) => httpRpc(socket, { url, ...params }),
    notifications: collectNotifications(socket),
    requests,
    requestBodies,
    async [Symbol.asyncDispose]() {
      socket.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("OpenClaw Codex sandbox exec-server HTTP", () => {
  it("cancels an outstanding nonstreaming HTTP response when its exec-server socket closes", async () => {
    const responseClosed = vi.fn();
    const responseReceived = createDeferred<ServerResponse>();
    let heldResponse: ServerResponse | undefined;
    await using fixture = await createLiveRedirectSandbox("source.test", 302, (response) => {
      heldResponse = response;
      response.once("close", responseClosed);
      responseReceived.resolve(response);
    });
    try {
      const response = await Promise.race([
        responseReceived.promise,
        fixture.request().then(() => {
          throw new Error("HTTP request completed before the fixture held its response");
        }),
      ]);
      const closed = once(response, "close");
      fixture.socket.terminate();
      await closed;
      expect(responseClosed).toHaveBeenCalledOnce();
    } finally {
      fixture.socket.terminate();
      heldResponse?.destroy();
    }
  });

  it("blocks private HTTP targets before starting the sandbox backend", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: { PATH: process.env.PATH },
      stdinMode: "pipe-closed" as const,
    }));
    const socket = await openSandboxSocket(createSandboxContext({ buildExecSpec }));
    await expect(httpRpc(socket, { url: "http://127.0.0.1:6379/" })).rejects.toThrow(
      "Blocked hostname or private/internal IP",
    );
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it.each([false, true])(
    "returns 308 without exposing credentials when redirectPolicy=stop (stream=%s)",
    async (streamResponse) => {
      await using fixture = await createLiveRedirectSandbox("target.test", 308);
      await expect(
        fixture.request({
          headers: [{ name: "authorization", value: "Bearer regression-secret" }],
          redirectPolicy: "stop",
          streamResponse,
        }),
      ).resolves.toEqual({
        status: 308,
        headers: expect.arrayContaining([header("location", expect.stringContaining("/final"))]),
        bodyBase64: streamResponse ? "" : base64("redirect body"),
      });
      if (streamResponse) {
        await expectBody(fixture.notifications, "redirect body");
      }
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it.each([
    { targetHost: "source.test", preserveCredentials: true },
    { targetHost: "target.test", preserveCredentials: false },
  ] as const)(
    "preserves POST bodies and only same-origin credentials across 308 redirects ($targetHost)",
    async ({ targetHost, preserveCredentials }) => {
      await using fixture = await createLiveRedirectSandbox(targetHost, 308);
      const credentials = [
        { name: "authorization", value: "Bearer regression-secret" },
        { name: "cookie", value: "session=regression-secret" },
        { name: "proxy-authorization", value: "Basic regression-secret" },
        { name: "www-authenticate", value: "Bearer challenge-secret" },
        { name: "cookie2", value: "session=another-regression-secret" },
      ];
      await expect(
        fixture.request({
          method: "POST",
          bodyBase64: base64('{"message":"keep"}'),
          headers: [
            ...credentials,
            { name: "x-request-id", value: "safe-request" },
            { name: "content-type", value: "application/json" },
          ],
          redirectPolicy: "follow",
          streamResponse: true,
        }),
      ).resolves.toEqual({
        status: 200,
        headers: expect.arrayContaining([header("content-type", "text/plain")]),
        bodyBase64: "",
      });
      await expectBody(fixture.notifications, "final body");
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[1]).toMatchObject({
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "safe-request" },
      });
      expect(fixture.requestBodies[1]).toBe('{"message":"keep"}');
      const redirectedHeaders = fixture.requests[1]?.headers;
      expect(credentials.map(({ name }) => redirectedHeaders?.[name])).toEqual(
        credentials.map(({ value }) => (preserveCredentials ? value : undefined)),
      );
    },
  );

  it.each([
    { targetHost: "127.0.0.1", streamResponse: false },
    { targetHost: "private.test", streamResponse: true },
  ] as const)(
    "blocks redirect destinations before connecting ($targetHost stream=$streamResponse)",
    async ({ targetHost, streamResponse }) => {
      await using fixture = await createLiveRedirectSandbox(targetHost, 308);
      await expect(fixture.request({ redirectPolicy: "follow", streamResponse })).rejects.toThrow(
        /Blocked.*private\/internal\/special-use/,
      );
      expect(fixture.requests).toHaveLength(1);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "preserves split UTF-8 in streaming HTTP %s",
    async (stream) => {
      const headers = stream === "stdout" ? [{ name: "X-Test", value: "猫-value" }] : [];
      const headerLine = `${JSON.stringify({ type: "headers", status: 200, headers })}\n`;
      const requestId = `http-split-${stream}`;
      const socket = await openScriptHttpSocket(splitUtf8ChildScript(stream, headerLine));
      const notifications = collectNotifications(socket);
      await expect(httpRpc(socket, { requestId, streamResponse: true })).resolves.toEqual({
        status: 200,
        headers,
        bodyBase64: "",
      });
      if (stream === "stderr") {
        await expect(waitForHttpBodyDeltas(notifications, 1)).resolves.toEqual([
          {
            requestId,
            seq: 1,
            deltaBase64: "",
            done: true,
            error: "sandbox failed: 猫 not found",
          },
        ]);
      }
      socket.close();
    },
  );

  it("rejects streaming HTTP helpers that never terminate a stdout line", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const socket = await openScriptHttpSocket(
      [
        `process.stdout.write("x".repeat(${SANDBOX_HTTP_STREAM_LINE_MAX_CHARS + 1}));`,
        "setInterval(() => {}, 1000);",
      ].join(""),
      finalizeExec,
    );

    await expect(httpRpc(socket, { streamResponse: true })).rejects.toThrow(
      "unterminated stdout line",
    );

    await vi.waitFor(
      () =>
        expect(finalizeExec).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed", token: "stream-line-token" }),
        ),
      { timeout: 5_000 },
    );
    socket.close();
  });
});
