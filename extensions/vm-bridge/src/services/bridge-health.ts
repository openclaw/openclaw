/**
 * Periodic health check for the bridge server.
 * Logs warnings if the bridge or MCP servers are unreachable.
 */

import type { BridgeClient } from "../bridge-client.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function createBridgeHealthService(bridge: BridgeClient, intervalMs: number) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let lastOk = true;

  return {
    id: "vm-bridge-health",
    start: async (ctx: { logger: Logger }) => {
      ctx.logger.info(`[vm-bridge] Bridge health monitor starting (interval: ${intervalMs}ms)`);

      const check = async () => {
        const result = await bridge.health();
        if (result.ok && !lastOk) {
          ctx.logger.info("[vm-bridge] Bridge server recovered");
        } else if (!result.ok && lastOk) {
          ctx.logger.warn(`[vm-bridge] Bridge server unreachable: ${result.error ?? "unknown"}`);
        }
        lastOk = result.ok;
      };

      await check();
      intervalHandle = setInterval(check, intervalMs);
    },
    stop: async (ctx: { logger: Logger }) => {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      ctx.logger.info("[vm-bridge] Bridge health monitor stopped");
    },
  };
}
