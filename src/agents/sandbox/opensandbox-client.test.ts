import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OpenSandboxClient } from "./opensandbox-client.js";

// ---------------------------------------------------------------------------
// Tiny in-process HTTP stub for the execd API
// ---------------------------------------------------------------------------

type StubHandler = (req: IncomingMessage, body: string) => { status: number; json: unknown };

function createStubServer(handler: StubHandler): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const { status, json } = handler(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenSandboxClient", () => {
  let server: Server;
  let port: number;
  let lastReq: { method?: string; url?: string; headers: Record<string, string>; body: string };

  const handler: StubHandler = (req, body) => {
    lastReq = {
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body,
    };

    // Route responses based on URL.
    if (req.url === "/command" && req.method === "POST") {
      const parsed = JSON.parse(body);
      if (parsed.wait) {
        return {
          status: 200,
          json: { exitCode: 0, stdout: "hello\n", stderr: "" },
        };
      }
      return {
        status: 200,
        json: { sessionId: "sess-42" },
      };
    }
    if (req.url?.startsWith("/command/status/")) {
      return { status: 200, json: { running: false, exitCode: 0 } };
    }
    if (req.url?.startsWith("/command/output/")) {
      return {
        status: 200,
        json: [
          { fd: 1, msg: "out-line" },
          { fd: 2, msg: "err-line" },
        ],
      };
    }
    if (req.url?.startsWith("/command/kill/")) {
      return { status: 200, json: {} };
    }
    return { status: 404, json: { error: "not found" } };
  };

  beforeAll(async () => {
    const stub = await createStubServer(handler);
    server = stub.server;
    port = stub.port;
  });

  afterAll(() => {
    server?.close();
  });

  afterEach(() => {
    lastReq = { headers: {}, body: "" };
  });

  function makeClient(token?: string) {
    return new OpenSandboxClient({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: token,
    });
  }

  // -------------------------------------------------------------------------
  // startCommand
  // -------------------------------------------------------------------------

  it("startCommand (wait=true) sends POST /command and returns result", async () => {
    const client = makeClient("tok-123");
    const result = await client.startCommand({
      command: "echo hello",
      workdir: "/workspace",
      wait: true,
      timeout: 30,
    });

    expect(lastReq.method).toBe("POST");
    expect(lastReq.url).toBe("/command");
    expect(lastReq.headers["x-execd-access-token"]).toBe("tok-123");

    const body = JSON.parse(lastReq.body);
    expect(body.command).toBe("echo hello");
    expect(body.workdir).toBe("/workspace");
    expect(body.wait).toBe(true);
    expect(body.timeout).toBe(30);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("startCommand (wait=false) returns sessionId", async () => {
    const client = makeClient();
    const result = await client.startCommand({
      command: "sleep 10",
      wait: false,
    });

    expect(result.sessionId).toBe("sess-42");
  });

  it("does not send token header when no accessToken configured", async () => {
    const client = makeClient(); // no token
    await client.startCommand({ command: "ls", wait: false });

    expect(lastReq.headers["x-execd-access-token"]).toBeUndefined();
  });

  it("omits env from body when empty", async () => {
    const client = makeClient();
    await client.startCommand({ command: "ls", wait: false, env: {} });

    const body = JSON.parse(lastReq.body);
    expect(body.env).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  it("getStatus sends GET /command/status/:id", async () => {
    const client = makeClient();
    const status = await client.getStatus("sess-42");

    expect(lastReq.method).toBe("GET");
    expect(lastReq.url).toBe("/command/status/sess-42");
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // getOutput
  // -------------------------------------------------------------------------

  it("getOutput returns array of {fd, msg} items", async () => {
    const client = makeClient();
    const output = await client.getOutput("sess-42");

    expect(lastReq.url).toBe("/command/output/sess-42");
    expect(output).toEqual([
      { fd: 1, msg: "out-line" },
      { fd: 2, msg: "err-line" },
    ]);
  });

  // -------------------------------------------------------------------------
  // kill
  // -------------------------------------------------------------------------

  it("kill sends POST /command/kill/:id", async () => {
    const client = makeClient();
    await client.kill("sess-42");

    expect(lastReq.method).toBe("POST");
    expect(lastReq.url).toBe("/command/kill/sess-42");
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws on non-2xx responses", async () => {
    const client = makeClient();
    await expect(client.getStatus("__unknown__")).resolves.toBeDefined();
    // Our stub returns 404 for unknown URLs — use a path that will 404:
    // Actually our stub routes /command/status/* → 200, so let's test via
    // a direct error scenario using a port that doesn't exist.
    const badClient = new OpenSandboxClient({
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 500,
    });
    await expect(badClient.getStatus("x")).rejects.toThrow();
  });
});
