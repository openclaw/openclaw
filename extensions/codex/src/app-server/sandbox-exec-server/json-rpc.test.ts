// Codex tests cover sandbox exec-server JSON-RPC parser behavior.
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { parseRequest, requireObject, requireString } from "./json-rpc.js";

describe("parseRequest", () => {
  it("throws descriptive error on malformed JSON", () => {
    expect(() => parseRequest(Buffer.from("NOT JSON {{{"))).toThrow(
      "JSON-RPC request body is not valid JSON.",
    );
  });

  it("throws descriptive error on empty data", () => {
    expect(() => parseRequest(Buffer.from(""))).toThrow("JSON-RPC request body is not valid JSON.");
  });

  it("parses a valid JSON-RPC request", () => {
    const result = parseRequest(
      Buffer.from(
        JSON.stringify({
          method: "tools/call",
          params: { name: "test", arguments: {} },
          id: 1,
        }),
      ),
    );
    expect(result.method).toBe("tools/call");
    expect(result.id).toBe(1);
  });

  it("throws requireObject error for non-object valid JSON", () => {
    expect(() => parseRequest(Buffer.from("[1,2,3]"))).toThrow(
      "JSON-RPC request must be an object.",
    );
  });
});

describe("requireObject", () => {
  it("returns the value when it is a non-array object", () => {
    expect(requireObject({ key: "val" }, "test")).toEqual({ key: "val" });
  });

  it("throws for null", () => {
    expect(() => requireObject(null, "test")).toThrow("test must be an object.");
  });

  it("throws for an array", () => {
    expect(() => requireObject([1, 2], "test")).toThrow("test must be an object.");
  });
});

describe("requireString", () => {
  it("returns the string when non-empty", () => {
    expect(requireString("hello", "param")).toBe("hello");
  });

  it("throws for empty string", () => {
    expect(() => requireString("", "param")).toThrow();
  });

  it("throws for non-string", () => {
    expect(() => requireString(123 as unknown as string, "param")).toThrow();
  });
});

describe("parseRequest WebSocket transport path", () => {
  // Reproduces the EXACT production code path from sandbox-exec-server.ts:308:
  //   socket.on("message", (data: RawData) => { parseRequest(data) })
  // RawData from ws library is Buffer | ArrayBuffer | Buffer[].

  const PORT = 19876;
  let wss: WebSocketServer;
  let httpServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer, path: "/exec" });
    await new Promise<void>((resolve) => httpServer.listen(PORT, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("throws descriptive error on malformed JSON received over WebSocket", async () => {
    // When a client sends malformed JSON text → server receives RawData →
    // parseRequest(data) → our new descriptive Error (matching line 308).
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/exec`);

    // Server: when it receives a message, call parseRequest exactly like production
    const serverReceived = new Promise<{ error: unknown }>((resolve) => {
      wss.once("connection", (serverWs) => {
        serverWs.once("message", (data: RawData) => {
          try {
            parseRequest(data);
            resolve({ error: undefined });
          } catch (err: unknown) {
            resolve({ error: err });
          }
        });
      });
    });

    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send("NOT JSON {{{");
    const result = await serverReceived;
    ws.close();

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain("not valid JSON");
  });

  it("parses valid JSON-RPC request received over WebSocket", async () => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/exec`);

    const serverReceived = new Promise<{ result: unknown; error: unknown }>((resolve) => {
      wss.once("connection", (serverWs) => {
        serverWs.once("message", (data: RawData) => {
          try {
            const req = parseRequest(data);
            resolve({ result: req, error: undefined });
          } catch (err: unknown) {
            resolve({ result: undefined, error: err });
          }
        });
      });
    });

    await new Promise<void>((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ method: "tools/call", params: {}, id: 1 }));
    const { result, error } = await serverReceived;
    ws.close();

    expect(error).toBeUndefined();
    expect((result as Record<string, unknown>)?.method).toBe("tools/call");
  });
});
