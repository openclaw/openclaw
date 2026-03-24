import { describe, expect, it } from "vitest";
import {
  JarvisMcpClient,
  createJsonRpcRequest,
  parseJsonRpcResponse,
  type JsonRpcResponse,
} from "./mcp-client.js";

describe("JSON-RPC helpers", () => {
  it("creates a well-formed JSON-RPC 2.0 request", () => {
    const req = createJsonRpcRequest("tools/list", {}, 1);
    expect(req).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
  });

  it("parses a valid JSON-RPC response", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    const parsed = parseJsonRpcResponse(raw);
    expect(parsed.id).toBe(1);
    expect((parsed as { result: unknown }).result).toEqual({ tools: [] });
  });

  it("parses a JSON-RPC error response", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "Invalid Request" },
    });
    const parsed = parseJsonRpcResponse(raw);
    expect((parsed as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseJsonRpcResponse("not json")).toThrow();
  });
});

describe("JarvisMcpClient", () => {
  it("exports a class with start/stop/callTool/listTools", async () => {
    const { JarvisMcpClient } = await import("./mcp-client.js");
    expect(JarvisMcpClient).toBeDefined();
    expect(typeof JarvisMcpClient.prototype.start).toBe("function");
    expect(typeof JarvisMcpClient.prototype.stop).toBe("function");
    expect(typeof JarvisMcpClient.prototype.callTool).toBe("function");
    expect(typeof JarvisMcpClient.prototype.listTools).toBe("function");
  });
});

describe("JarvisMcpClient.onData (protocol parsing)", () => {
  it("parses a complete Content-Length framed message", () => {
    const client = new JarvisMcpClient({
      pythonCommand: "python3",
      jarvisPath: "/tmp/fake",
    });

    let resolved: unknown = null;
    const pending = (
      client as unknown as {
        pending: Map<
          number,
          {
            resolve: (v: unknown) => void;
            reject: () => void;
            timer: ReturnType<typeof setTimeout>;
          }
        >;
      }
    ).pending;
    const timer = setTimeout(() => {}, 10000);
    pending.set(1, {
      resolve: (v: unknown) => {
        resolved = v;
      },
      reject: () => {},
      timer,
    });

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    (client as unknown as { onData(chunk: string): void }).onData(frame);

    // timer is cleared by onData; no need to clearTimeout here
    expect(resolved).toBeTruthy();
    expect((resolved as { result: { ok: boolean } }).result.ok).toBe(true);
    client.stop();
  });

  it("handles split chunks across multiple onData calls", () => {
    const client = new JarvisMcpClient({
      pythonCommand: "python3",
      jarvisPath: "/tmp/fake",
    });

    let resolved: unknown = null;
    const pending = (
      client as unknown as {
        pending: Map<
          number,
          {
            resolve: (v: unknown) => void;
            reject: () => void;
            timer: ReturnType<typeof setTimeout>;
          }
        >;
      }
    ).pending;
    const timer = setTimeout(() => {}, 10000);
    pending.set(2, {
      resolve: (v: unknown) => {
        resolved = v;
      },
      reject: () => {},
      timer,
    });

    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { data: "hello" } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    const mid = Math.floor(frame.length / 2);
    (client as unknown as { onData(chunk: string): void }).onData(frame.slice(0, mid));
    expect(resolved).toBeNull();
    (client as unknown as { onData(chunk: string): void }).onData(frame.slice(mid));
    expect(resolved).toBeTruthy();
    client.stop();
  });
});
