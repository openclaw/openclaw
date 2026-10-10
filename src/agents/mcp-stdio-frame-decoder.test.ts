import { describe, expect, it } from "vitest";
import { McpStdioFrameDecoder, McpStdioFrameError } from "./mcp-stdio-frame-decoder.js";

describe("McpStdioFrameDecoder", () => {
  it.each([0, 10])("bounds each frame in a combined chunk after %i pending bytes", (split) => {
    const frame = (id: number) => {
      const response = { jsonrpc: "2.0", id, result: { text: "x".repeat(32) } };
      return { response, bytes: Buffer.from(`${JSON.stringify(response)}\n`) };
    };
    const first = frame(0);
    const second = frame(1);
    const third = frame(2);
    const decoder = new McpStdioFrameDecoder(first.bytes.length);
    decoder.append(first.bytes.subarray(0, split));
    expect(decoder.readMessage()).toBeNull();

    decoder.append(
      Buffer.concat([first.bytes.subarray(split), second.bytes, third.bytes.subarray(0, 10)]),
    );
    expect(decoder.readMessage()).toEqual(first.response);
    expect(decoder.readMessage()).toEqual(second.response);
    expect(decoder.readMessage()).toBeNull();
    decoder.append(third.bytes.subarray(10));
    expect(decoder.readMessage()).toEqual(third.response);
    expect(decoder.readMessage()).toBeNull();
  });

  it("rejects an oversized append before retaining any of its bytes", () => {
    const response = { jsonrpc: "2.0", id: 0, result: {} };
    const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
    const decoder = new McpStdioFrameDecoder(bytes.length);
    decoder.append(bytes.subarray(0, 10));
    expect(decoder.readMessage()).toBeNull();

    expect(() => decoder.append(Buffer.alloc(bytes.length))).toThrow(
      new McpStdioFrameError("response exceeded the line-size limit"),
    );
    decoder.append(bytes.subarray(10));
    expect(decoder.readMessage()).toEqual(response);
    expect(decoder.readMessage()).toBeNull();
  });

  it.each(["\n", ""])(
    "rejects an oversized later frame with delimiter %j before retaining the chunk",
    (delimiter) => {
      const response = { jsonrpc: "2.0", id: 0, result: {} };
      const bytes = Buffer.from(`${JSON.stringify(response)}\n`);
      const decoder = new McpStdioFrameDecoder(bytes.length);
      decoder.append(bytes.subarray(0, 10));
      expect(decoder.readMessage()).toBeNull();

      expect(() =>
        decoder.append(
          Buffer.concat([
            bytes.subarray(10),
            Buffer.from("x".repeat(bytes.length + 1) + delimiter),
          ]),
        ),
      ).toThrow("response exceeded the line-size limit");
      decoder.append(bytes.subarray(10));
      expect(decoder.readMessage()).toEqual(response);
      expect(decoder.readMessage()).toBeNull();
    },
  );

  it("preserves a UTF-8 character split across chunks and skips empty lines", () => {
    const response = { jsonrpc: "2.0", id: 0, result: { text: "β雪🦞" } };
    const bytes = Buffer.from(`\n\n${JSON.stringify(response)}\n\n`);
    const split = bytes.indexOf(Buffer.from("雪")) + 1;
    const decoder = new McpStdioFrameDecoder(bytes.length);
    decoder.append(bytes.subarray(0, split));
    expect(decoder.readMessage()).toBeNull();
    decoder.append(bytes.subarray(split));
    expect(decoder.readMessage()).toEqual(response);
    expect(decoder.readMessage()).toBeNull();
  });

  it.each([
    { line: "not-json", message: "proxy returned invalid JSON", cause: SyntaxError },
    {
      line: '{"jsonrpc":"1.0","id":0,"result":{}}',
      message: "proxy returned an invalid JSON-RPC version",
    },
    {
      line: '{"jsonrpc":"2.0","id":0}',
      message: "proxy returned an invalid JSON-RPC message",
      cause: Error,
    },
    {
      line: '{"jsonrpc":"2.0","id":"0","result":{}}',
      message: "proxy returned an invalid response id",
    },
  ])("classifies $message", ({ line, message, cause }) => {
    const decoder = new McpStdioFrameDecoder(1024);
    decoder.append(Buffer.from(`${line}\n`));
    let failure: unknown;
    try {
      decoder.readMessage();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(McpStdioFrameError);
    expect(failure).toMatchObject({ message, ...(cause ? { cause: expect.any(cause) } : {}) });
  });

  it.each([
    { jsonrpc: "2.0", id: 0, result: { value: "unchanged" } },
    { jsonrpc: "2.0", id: 0, error: { code: -32000, message: "refused" } },
    { jsonrpc: "2.0", id: "server-request", method: "ping", params: {} },
    { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } },
  ])("passes through $jsonrpc message $id $method unchanged", (message) => {
    const decoder = new McpStdioFrameDecoder(1024);
    decoder.append(Buffer.from(`${JSON.stringify(message)}\n`));
    expect(decoder.readMessage()).toEqual(message);
  });
});
