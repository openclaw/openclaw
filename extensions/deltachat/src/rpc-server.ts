import type { DeltaChatOverJsonRpcServer } from "@deltachat/stdio-rpc-server";
import { startDeltaChat } from "@deltachat/stdio-rpc-server";
import { getDeltaChatRuntime, updateDeltaChatRuntimeState } from "./runtime.js";
import { DEFAULT_DATA_DIR } from "./types.js";
import { ensureDataDir } from "./utils.js";

// Signal handling for graceful shutdown
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGUSR2"];

// Helper to get logger - falls back to console if runtime not available
function getLogger() {
  try {
    const core = getDeltaChatRuntime();
    const logger = core.logging.getChildLogger({ module: "deltachat-rpc" });
    return {
      log: (...args: unknown[]) => logger.info(String(args.join(" "))),
      error: (...args: unknown[]) => logger.error(String(args.join(" "))),
    };
  } catch {
    // Runtime not initialized yet, fall back to console
    return {
      log: console.log,
      error: console.error,
    };
  }
}

// Increase max listeners to prevent warnings in tests
// Only set if not already set to avoid interfering with running processes
if (process.getMaxListeners() < 50) {
  process.setMaxListeners(50);
}

// Check if we're running in test mode (evaluated at runtime, not module load time)
const isTestMode = () => {
  // Skip test mode if explicitly disabled (used by rpc-server.test.ts to test actual startup)
  if (process.env.DELTACHAT_SKIP_TEST_MOCK === "true") {
    return false;
  }
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
};

/**
 * Manages the lifecycle of the Delta.Chat RPC server.
 * This is a singleton that ensures only one RPC server instance is running at a time.
 */
class DeltaChatRpcServerManager {
  private dc: DeltaChatOverJsonRpcServer | null = null;
  private dataDir: string | null = null;
  private isStarting = false;
  private isStopping = false;
  private signalHandlers: Map<NodeJS.Signals, () => void> = new Map();

  /**
   * Register signal handlers for graceful shutdown.
   * This ensures the RPC server is properly stopped when the process receives
   * termination signals (SIGTERM, SIGINT, SIGUSR2).
   *
   * Note: Signal handlers are NOT registered in test mode to avoid interfering
   * with the test process or other running processes.
   */
  private registerSignalHandlers(): void {
    // Skip signal handler registration in test mode to avoid interfering with
    // the test process or other running processes (e.g., gateway)
    if (isTestMode()) {
      getLogger().log(`[deltachat] Skipping signal handler registration in test mode`);
      return;
    }

    for (const signal of SIGNALS) {
      const handler = () => {
        getLogger().log(`[deltachat] Received ${signal}, initiating graceful shutdown...`);
        this.stop().catch((err) => {
          getLogger().error(`[deltachat] Error during signal-triggered shutdown: ${err}`);
        });
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  /**
   * Unregister signal handlers.
   * This should be called when the RPC server is stopped to prevent
   * signal handlers from being called on a stopped server.
   */
  private unregisterSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
  }

  /**
   * Check if the RPC server is responsive by making a simple RPC call.
   * Returns true if the server is running and responsive, false otherwise.
   */
  async isResponsive(): Promise<boolean> {
    if (!this.dc) {
      return false;
    }
    try {
      await this.dc.rpc.getSystemInfo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the RPC server if not already running.
   * Returns the DeltaChat instance if successful, null if already running or if
   * another server is running with a different data directory.
   * Includes retry logic for transient failures.
   *
   * Note: In test mode, this method returns a mock RPC server instance to prevent
   * spawning real RPC server subprocesses and interacting with real-world servers.
   */
  async start(dataDir?: string): Promise<DeltaChatOverJsonRpcServer | null> {
    const dir = dataDir ?? DEFAULT_DATA_DIR;
    const expandedDir = ensureDataDir(dir);

    getLogger().log(`[deltachat] Starting RPC server for dataDir: ${expandedDir}`);

    // In test mode, return a mock RPC server instance to prevent spawning real subprocesses
    if (isTestMode()) {
      getLogger().log(`[deltachat] Running in test mode, returning mock RPC server`);
      // Return a mock RPC server instance that matches the DeltaChatOverJsonRpcServer type
      // This prevents spawning real RPC server subprocesses during tests
      const mockRpcServer = {
        rpc: {
          getSystemInfo: async () => ({}),
          getAllAccounts: async () => [],
          stopIo: async (_accountId: number) => {},
        },
        close: () => {},
        transport: {
          input: {
            end: () => {},
          },
        },
        // Add other required properties with no-op implementations
        contextEmitters: {},
        eventTask: () => {},
        eventLoop: () => {},
        listAccounts: async () => [],
        // Add any other required properties as no-ops
      } as unknown as DeltaChatOverJsonRpcServer;
      this.dc = mockRpcServer;
      this.dataDir = expandedDir;
      return mockRpcServer;
    }

    if (this.dc) {
      // Already running - check if data directory matches
      if (this.dataDir !== expandedDir) {
        // Different data directory - cannot reuse
        getLogger().log(
          `[deltachat] RPC server already running with different dataDir, returning null`,
        );
        return null;
      }
      // Same data directory - check if still responsive
      if (await this.isResponsive()) {
        getLogger().log(`[deltachat] RPC server already running and responsive`);
        return this.dc;
      }
      // Not responsive - stop and restart
      getLogger().log(`[deltachat] RPC server not responsive, stopping and restarting...`);
      await this.stop();
    }

    if (this.isStarting) {
      // Already in the process of starting
      getLogger().log(`[deltachat] RPC server already starting, returning null`);
      return null;
    }

    this.isStarting = true;
    try {
      this.dataDir = expandedDir;

      // Retry logic for RPC server startup
      const maxRetries = 3;
      const baseDelayMs = 500;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Only log attempt number on retries
          if (attempt > 1) {
            getLogger().log(`[deltachat] Retry attempt ${attempt}/${maxRetries}...`);
          }
          this.dc = await startDeltaChat(expandedDir);
          updateDeltaChatRuntimeState({ lastStartAt: Date.now() });
          // Only log success message on retries
          if (attempt > 1) {
            getLogger().log(
              `[deltachat] RPC server started successfully after ${attempt} attempts`,
            );
          }
          // Register signal handlers for graceful shutdown
          this.registerSignalHandlers();
          return this.dc;
        } catch (err) {
          if (attempt === maxRetries) {
            // Final attempt failed, rethrow the error
            getLogger().log(
              `[deltachat] Failed to start RPC server after ${maxRetries} attempts: ${err}`,
            );
            throw err;
          }
          // Wait before retrying with exponential backoff
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          getLogger().log(`[deltachat] Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Should never reach here, but just in case
      getLogger().log(`[deltachat] Unexpected state, returning null`);
      return null;
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Get the current RPC server instance.
   * Optionally validates that the server is using the specified data directory.
   * Returns null if not running or if data directory doesn't match.
   */
  get(dataDir?: string): DeltaChatOverJsonRpcServer | null {
    if (!this.dc) {
      return null;
    }

    // If dataDir is specified, verify it matches
    if (dataDir) {
      const expandedDir = ensureDataDir(dataDir);
      if (this.dataDir !== expandedDir) {
        return null;
      }
    }

    return this.dc;
  }

  /**
   * Stop the RPC server if running.
   * This method gracefully stops IO operations and then shuts down the RPC server.
   * The RPC server process will be killed by closing stdin and calling close().
   */
  async stop(): Promise<void> {
    if (!this.dc || this.isStopping) {
      getLogger().log(`[deltachat] RPC server not running or already stopping`);
      return;
    }

    getLogger().log(`[deltachat] Stopping RPC server...`);
    this.isStopping = true;
    try {
      // Stop all IO operations
      try {
        // TODO: use this.dc.rpc.stopIoForAllAccounts() instead
        // await this.dc.rpc.stopIoForAllAccounts();
        const accounts = await this.dc.rpc.getAllAccounts();
        getLogger().log(`[deltachat] Stopping IO for ${accounts.length} accounts...`);
        for (const account of accounts) {
          await this.dc.rpc.stopIo(account.id);
        }
      } catch (err) {
        // Ignore errors during stopIo
        getLogger().log(`[deltachat] Error stopping IO: ${err}`);
      }

      // Neutralize the transport's _send method before closing stdin.
      // The library's eventLoop() is an infinite while(true) that calls
      // getNextEvent() via transport._send → input.write(). If we close
      // stdin first, the next loop iteration causes "write after end".
      // Making _send a no-op prevents that crash; the pending request
      // simply never resolves, which is fine since we kill the process next.
      const transport = this.dc.transport as {
        _send?: (...args: unknown[]) => void;
        input?: { end: () => void };
      };
      if (transport._send) {
        transport._send = () => {};
      }

      // Close stdin to signal EOF to the RPC server process
      // This allows the server to exit gracefully
      getLogger().log(`[deltachat] Closing stdin to signal EOF...`);
      if (transport.input) {
        transport.input.end();
      }

      // Kill the RPC server process
      // The @deltachat/stdio-rpc-server package provides a close() method
      // that kills the spawned server process
      getLogger().log(`[deltachat] Killing RPC server process...`);
      if (typeof this.dc.close === "function") {
        this.dc.close();
      }

      this.dc = null;
      this.dataDir = null;
      updateDeltaChatRuntimeState({ lastStopAt: Date.now() });
      getLogger().log(`[deltachat] RPC server stopped successfully`);
      // Unregister signal handlers
      this.unregisterSignalHandlers();
    } finally {
      this.isStopping = false;
    }
  }

  /**
   * Check if the RPC server is running.
   */
  isRunning(): boolean {
    return this.dc !== null;
  }

  /**
   * Get the data directory being used.
   */
  getDataDir(): string | null {
    return this.dataDir;
  }
}

/**
 * Singleton instance of the RPC server manager.
 */
export const rpcServerManager = new DeltaChatRpcServerManager();
