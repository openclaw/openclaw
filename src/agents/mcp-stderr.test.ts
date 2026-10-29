import process from "node:process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransport } from "./mcp-transport.js";

const { logDebug } = vi.hoisted(() => ({ logDebug: vi.fn() }));
vi.mock("../logger.js", () => ({ logDebug }));

function createStderrProbe(args?: string[]) {
  const resolved = resolveMcpTransport("probe", { command: process.execPath, args });
  if (!resolved || !(resolved.transport instanceof OpenClawStdioClientTransport)) {
    throw new Error("Expected a stdio transport");
  }
  const stderr = resolved.transport.stderr;
  if (!(stderr instanceof PassThrough)) {
    throw new Error("Expected a writable stderr test pipe");
  }
  return { ...resolved, transport: resolved.transport, stderr };
}

describe("MCP stderr diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
    logDebug.mockClear();
  });

  it("keeps diagnostics attached through forced disposal", async () => {
    vi.useFakeTimers();
    const probe = createStderrProbe();
    const closed = createDeferred();
    const close = vi.spyOn(probe.transport, "close").mockReturnValue(closed.promise);
    const forceClose = vi.spyOn(probe.transport, "forceClose").mockImplementation(async () => {
      probe.stderr.write("forced shutdown tail");
      closed.resolve();
    });
    try {
      const disposing = disposeMcpClient({ ...probe, client: { close: async () => {} } }, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(disposing).resolves.toBe("closed");
      expect(forceClose).toHaveBeenCalledOnce();
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: stderr output omitted"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      close.mockRestore();
      forceClose.mockRestore();
      probe.detachStderr?.();
    }
  });

  it("drains a real child's shutdown stderr with one content-free activity notice", async () => {
    const probe = createStderrProbe([
      "-e",
      `process.stdin.resume();
       process.stdin.on("end", () => {
         const message = Buffer.from("shutdown 你好 private-message-marker private-tool-argument-marker private-tool-result-marker");
         process.stderr.write(message.subarray(0, 10));
         setImmediate(() => process.stderr.end(message.subarray(10)));
       });`,
    ]);
    try {
      await probe.transport.start();
      await disposeMcpClient({ ...probe, client: { close: async () => {} } });
      expect(logDebug.mock.calls).toEqual([["bundle-mcp:probe: stderr output omitted"]]);
      expect(probe.transport.pid).toBeNull();
    } finally {
      await probe.transport.forceClose();
      probe.detachStderr?.();
    }
  });
});
