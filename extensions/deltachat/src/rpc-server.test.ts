import type { DeltaChatOverJsonRpcServer } from "@deltachat/stdio-rpc-server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external modules
vi.mock("@deltachat/stdio-rpc-server", () => ({
  startDeltaChat: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  updateDeltaChatRuntimeState: vi.fn(),
}));

vi.mock("./types.js", () => ({
  DEFAULT_DATA_DIR: "~/.openclaw/state/deltachat",
}));

vi.mock("./utils.js", () => ({
  ensureDataDir: vi.fn((dir: string) => dir),
}));

describe("DeltaChatRpcServerManager", () => {
  let mockDc: any;
  let mockStartDeltaChat: any;
  let mockUpdateDeltaChatRuntimeState: any;
  let mockEnsureDataDir: any;

  beforeEach(async () => {
    // Set environment variable to skip test mode mock
    // This allows testing the actual RPC server startup behavior
    process.env.DELTACHAT_SKIP_TEST_MOCK = "true";

    // Reset all mocks
    vi.resetModules();
    vi.clearAllMocks();

    // Create mock DeltaChat instance with proper vi.fn() mocks
    mockDc = {
      rpc: {
        getSystemInfo: vi.fn().mockResolvedValue({}),
        getAllAccounts: vi.fn().mockResolvedValue([]),
        stopIo: vi.fn().mockResolvedValue(null),
      },
      close: vi.fn(),
      transport: {
        input: {
          end: vi.fn(),
        },
      },
    } as any;

    // Get mocked functions
    const stdioModule = await import("@deltachat/stdio-rpc-server");
    mockStartDeltaChat = stdioModule.startDeltaChat;
    mockStartDeltaChat.mockResolvedValue(mockDc);

    const runtimeModule = await import("./runtime.js");
    mockUpdateDeltaChatRuntimeState = runtimeModule.updateDeltaChatRuntimeState;

    const utilsModule = await import("./utils.js");
    mockEnsureDataDir = utilsModule.ensureDataDir;
  });

  afterEach(() => {
    // Clean up singleton state between tests
    // This is tricky with ES modules - we need to reset the module
    vi.resetModules();
    // Clean up environment variable
    delete process.env.DELTACHAT_SKIP_TEST_MOCK;
  });

  describe("start()", () => {
    it("should start RPC server with default data directory", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const result = await rpcServerManager.start();

      expect(mockStartDeltaChat).toHaveBeenCalledWith("~/.openclaw/state/deltachat");
      expect(result).toBe(mockDc);
      expect(mockUpdateDeltaChatRuntimeState).toHaveBeenCalledWith({
        lastStartAt: expect.any(Number),
      });
    });

    it("should start RPC server with custom data directory", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const customDir = "/custom/data/dir";
      const result = await rpcServerManager.start(customDir);

      expect(mockStartDeltaChat).toHaveBeenCalledWith(customDir);
      expect(result).toBe(mockDc);
    });

    it("should return existing instance if already running with same data directory", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start the server
      await rpcServerManager.start("/test/dir");

      // Reset mock to track second call
      mockStartDeltaChat.mockClear();

      // Try to start again with same directory
      const result = await rpcServerManager.start("/test/dir");

      expect(mockStartDeltaChat).not.toHaveBeenCalled();
      expect(result).toBe(mockDc);
    });

    it("should return null if already running with different data directory", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start the server with first directory
      await rpcServerManager.start("/test/dir1");

      // Try to start with different directory
      const result = await rpcServerManager.start("/test/dir2");

      expect(result).toBeNull();
    });

    it("should retry on startup failure", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Mock failure on first two attempts, success on third
      mockStartDeltaChat
        .mockRejectedValueOnce(new Error("First attempt failed"))
        .mockRejectedValueOnce(new Error("Second attempt failed"))
        .mockResolvedValueOnce(mockDc);

      const result = await rpcServerManager.start("/test/dir");

      expect(mockStartDeltaChat).toHaveBeenCalledTimes(3);
      expect(result).toBe(mockDc);
    });

    it("should return null after max retries exceeded", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Mock all attempts to fail
      mockStartDeltaChat.mockRejectedValue(new Error("Always fails"));

      await expect(rpcServerManager.start("/test/dir")).rejects.toThrow("Always fails");
    });

    it("should handle non-responsive server by stopping and restarting", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server
      await rpcServerManager.start("/test/dir");

      // Mock isResponsive to return false
      const isResponsiveSpy = vi.spyOn(rpcServerManager, "isResponsive").mockResolvedValue(false);

      // Try to start again - should stop and restart
      mockStartDeltaChat.mockClear();
      await rpcServerManager.start("/test/dir");

      expect(isResponsiveSpy).toHaveBeenCalled();
      expect(mockStartDeltaChat).toHaveBeenCalled();
    });

    it("should prevent concurrent start attempts", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Create a promise that never resolves to simulate slow startup
      let resolveStart: (value: DeltaChatOverJsonRpcServer) => void;
      const slowStartPromise = new Promise<DeltaChatOverJsonRpcServer>((resolve) => {
        resolveStart = resolve;
      });

      mockStartDeltaChat.mockReturnValue(slowStartPromise);

      // Start first call
      const promise1 = rpcServerManager.start("/test/dir");

      // Try to start again while first is still starting
      const promise2 = rpcServerManager.start("/test/dir");

      // Resolve the slow start
      resolveStart!(mockDc);

      const result1 = await promise1;
      const result2 = await promise2;

      // First call should succeed, second should return null (already starting)
      expect(result1).toBe(mockDc);
      expect(result2).toBeNull();
    });
  });

  describe("stop()", () => {
    it("should stop running RPC server", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      // Mock accounts for stopIo
      mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "account1" }, { id: "account2" }]);

      await rpcServerManager.stop();

      expect(mockDc.rpc.stopIo).toHaveBeenCalledTimes(2);
      expect(mockDc.rpc.stopIo).toHaveBeenCalledWith("account1");
      expect(mockDc.rpc.stopIo).toHaveBeenCalledWith("account2");
      expect(mockDc.transport.input.end).toHaveBeenCalled();
      expect(mockDc.close).toHaveBeenCalled();
      expect(mockUpdateDeltaChatRuntimeState).toHaveBeenCalledWith({
        lastStopAt: expect.any(Number),
      });
    });

    it("should handle stopIo errors gracefully", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      // Mock stopIo to throw error
      mockDc.rpc.stopIo.mockRejectedValue(new Error("stopIo failed"));

      // Should not throw
      await expect(rpcServerManager.stop()).resolves.not.toThrow();

      // Should still call close and transport.input.end
      expect(mockDc.transport.input.end).toHaveBeenCalled();
      expect(mockDc.close).toHaveBeenCalled();
    });

    it("should not stop if not running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Don't start server
      await rpcServerManager.stop();

      expect(mockDc.close).not.toHaveBeenCalled();
      expect(mockDc.transport.input.end).not.toHaveBeenCalled();
    });

    it("should prevent concurrent stop attempts", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      // Mock close to be slow
      let resolveClose: () => void;
      const slowClosePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      mockDc.close.mockReturnValue(slowClosePromise);

      // Start first stop
      const promise1 = rpcServerManager.stop();

      // Try to stop again while first is still stopping
      const promise2 = rpcServerManager.stop();

      // Resolve the slow close
      resolveClose!();

      await promise1;
      await promise2;

      // close should only be called once
      expect(mockDc.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("isResponsive()", () => {
    it("should return true if RPC server is responsive", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      // Mock successful response
      mockDc.rpc.getSystemInfo.mockResolvedValue({});

      const result = await rpcServerManager.isResponsive();

      expect(result).toBe(true);
      expect(mockDc.rpc.getSystemInfo).toHaveBeenCalled();
    });

    it("should return false if RPC server is not running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const result = await rpcServerManager.isResponsive();

      expect(result).toBe(false);
      expect(mockDc.rpc.getSystemInfo).not.toHaveBeenCalled();
    });

    it("should return false if RPC call fails", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      // Mock failure
      mockDc.rpc.getSystemInfo.mockRejectedValue(new Error("RPC failed"));

      const result = await rpcServerManager.isResponsive();

      expect(result).toBe(false);
    });
  });

  describe("get()", () => {
    it("should return running instance", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      const result = rpcServerManager.get();

      expect(result).toBe(mockDc);
    });

    it("should return null if not running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const result = rpcServerManager.get();

      expect(result).toBeNull();
    });

    it("should validate data directory when specified", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server with specific directory
      await rpcServerManager.start("/test/dir1");

      // Get with matching directory
      const result1 = rpcServerManager.get("/test/dir1");
      expect(result1).toBe(mockDc);

      // Get with different directory
      const result2 = rpcServerManager.get("/test/dir2");
      expect(result2).toBeNull();
    });
  });

  describe("isRunning()", () => {
    it("should return true when server is running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server first
      await rpcServerManager.start("/test/dir");

      const result = rpcServerManager.isRunning();

      expect(result).toBe(true);
    });

    it("should return false when server is not running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const result = rpcServerManager.isRunning();

      expect(result).toBe(false);
    });
  });

  describe("getDataDir()", () => {
    it("should return current data directory when running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      // Start server with specific directory
      await rpcServerManager.start("/test/dir");

      const result = rpcServerManager.getDataDir();

      expect(result).toBe("/test/dir");
    });

    it("should return null when not running", async () => {
      const { rpcServerManager } = await import("./rpc-server.js");

      const result = rpcServerManager.getDataDir();

      expect(result).toBeNull();
    });
  });
});
