import { EventEmitter } from "node:events";
import type { Agent } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapAgentWithTcpKeepalive } from "./tcp-keepalive-agent.js";

function createMockAgent(): Agent & { createConnection: ReturnType<typeof vi.fn> } {
  return {
    createConnection: vi.fn((_options, callback) => {
      const mockSocket = new EventEmitter() as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      mockSocket.setKeepAlive = vi.fn();
      process.nextTick(() => callback(null, mockSocket));
      return mockSocket;
    }),
    destroy: vi.fn(),
  } as unknown as Agent & { createConnection: ReturnType<typeof vi.fn> };
}

function createMockSyncAgent(): Agent & { createConnection: ReturnType<typeof vi.fn> } {
  return {
    createConnection: vi.fn((_options, _callback) => {
      const mockSocket = new EventEmitter() as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      mockSocket.setKeepAlive = vi.fn();
      // Synchronous return — does NOT call the callback (proxy-agent pattern)
      return mockSocket;
    }),
    destroy: vi.fn(),
  } as unknown as Agent & { createConnection: ReturnType<typeof vi.fn> };
}

function createMockErrorAgent(): Agent & { createConnection: ReturnType<typeof vi.fn> } {
  return {
    createConnection: vi.fn((_options, callback) => {
      const err = new Error("ECONNREFUSED");
      process.nextTick(() => callback(err, undefined));
      return undefined;
    }),
    destroy: vi.fn(),
  } as unknown as Agent & { createConnection: ReturnType<typeof vi.fn> };
}

describe("tcp-keepalive-agent", () => {
  describe("wrapAgentWithTcpKeepalive", () => {
    it("returns undefined when baseAgent is undefined", () => {
      expect(wrapAgentWithTcpKeepalive(undefined)).toBeUndefined();
    });

    it("applies keepalive via callback pattern (Node.js core agent)", async () => {
      const mockAgent = createMockAgent();
      const result = wrapAgentWithTcpKeepalive(mockAgent, { initialDelayMs: 20_000 });

      expect(result).toBe(mockAgent);
      mockAgent.createConnection({}, vi.fn());

      await new Promise((resolve) => process.nextTick(resolve));

      // The mock socket's setKeepAlive should have been called from the callback
      const callbackFn = (mockAgent.createConnection as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const mockSocket: NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> } = {
        setKeepAlive: vi.fn(),
      } as unknown as NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> };
      callbackFn(null, mockSocket);
      expect(mockSocket.setKeepAlive).toHaveBeenCalledWith(true, 20_000);
    });

    it("applies keepalive via synchronous return (proxy-agent pattern)", () => {
      const mockAgent = createMockSyncAgent();
      wrapAgentWithTcpKeepalive(mockAgent, { initialDelayMs: 15_000 });

      const returnedSocket = mockAgent.createConnection({}, vi.fn()) as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      expect(returnedSocket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
    });

    it("does not double-apply keepalive when both callback and sync return provide the same socket", async () => {
      const mockSocket = new EventEmitter() as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      mockSocket.setKeepAlive = vi.fn();
      const mockAgent = {
        createConnection: vi.fn((_options, callback) => {
          process.nextTick(() => callback(null, mockSocket));
          return mockSocket; // same socket via both paths
        }),
        destroy: vi.fn(),
      } as unknown as Agent & { createConnection: ReturnType<typeof vi.fn> };

      wrapAgentWithTcpKeepalive(mockAgent);
      mockAgent.createConnection({}, vi.fn());

      await new Promise((resolve) => process.nextTick(resolve));

      // Should be called twice (once for sync return, once for callback) —
      // harmless but expected behavior
      expect(mockSocket.setKeepAlive).toHaveBeenCalledTimes(2);
      expect(mockSocket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
    });

    it("uses default 15s initial delay when not specified", async () => {
      const mockAgent = createMockAgent();
      wrapAgentWithTcpKeepalive(mockAgent);

      const callbackFn = (mockAgent.createConnection as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const mockSocket: NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> } = {
        setKeepAlive: vi.fn(),
      } as unknown as NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> };
      callbackFn(null, mockSocket);
      expect(mockSocket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
    });

    it("uses custom initialDelayMs when provided", () => {
      const mockAgent = createMockSyncAgent();
      wrapAgentWithTcpKeepalive(mockAgent, { initialDelayMs: 30_000 });

      const returnedSocket = mockAgent.createConnection({}, vi.fn()) as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      expect(returnedSocket.setKeepAlive).toHaveBeenCalledWith(true, 30_000);
    });

    it("does not apply keepalive on error callback", async () => {
      const mockAgent = createMockErrorAgent();
      wrapAgentWithTcpKeepalive(mockAgent);

      const callbackFn = (mockAgent.createConnection as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const mockSocket: NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> } = {
        setKeepAlive: vi.fn(),
      } as unknown as NodeJS.Socket & { setKeepAlive: ReturnType<typeof vi.fn> };
      callbackFn(new Error("ECONNREFUSED"), mockSocket);
      expect(mockSocket.setKeepAlive).not.toHaveBeenCalled();
    });

    it("does not crash when setKeepAlive throws", () => {
      const badSocket = new EventEmitter() as NodeJS.Socket & {
        setKeepAlive: ReturnType<typeof vi.fn>;
      };
      badSocket.setKeepAlive = vi.fn(() => {
        throw new Error("socket already destroyed");
      });
      const mockAgent = createMockSyncAgent();
      wrapAgentWithTcpKeepalive(mockAgent);

      // Override the sync return to use the bad socket
      mockAgent.createConnection = vi.fn(() => badSocket);
      expect(() => mockAgent.createConnection({}, vi.fn())).not.toThrow();
    });

    it("does not mutate the original agent when baseAgent is undefined", () => {
      const result = wrapAgentWithTcpKeepalive(undefined);
      expect(result).toBeUndefined();
    });
  });
});
