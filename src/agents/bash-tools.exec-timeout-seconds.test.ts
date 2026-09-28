import { describe, expect, it } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createExecTool } from "./bash-tools.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

describe("removed exec timeout field", () => {
  it("rejects a stale timeout argument before command execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("legacy-timeout", {
        command: "exit 99",
        timeout: 5,
      } as never),
    ).rejects.toThrow('exec parameter "timeout" is unsupported; use "timeoutSeconds" instead');
  });
});

describe("foreground node exec wait budgets", () => {
  it.each([
    { timeoutSec: undefined, timeoutSeconds: undefined, expectedMs: 1_810_000 },
    { timeoutSec: 120, timeoutSeconds: 0, expectedMs: 130_000 },
    { timeoutSec: 120, timeoutSeconds: 1, expectedMs: 15_000 },
    { timeoutSec: 120, timeoutSeconds: Number.MAX_VALUE, expectedMs: MAX_SAFE_TIMEOUT_DELAY_MS },
  ])(
    "keeps prepared and pinned budgets for $timeoutSec/$timeoutSeconds seconds",
    ({ timeoutSec, timeoutSeconds, expectedMs }) => {
      for (const createTool of [createExecTool, createLazyExecTool]) {
        const tool = createTool({ host: "node", timeoutSec });
        const args = { command: "echo ready", timeoutSeconds };
        expect(tool.getExecutionTimeoutMs?.(args)).toBe(expectedMs);

        const nodeTool = pinExecToolTarget(tool, { host: "node" });
        expect(nodeTool.getExecutionTimeoutMs?.({ ...args, host: "gateway" })).toBe(expectedMs);

        const gatewayTool = pinExecToolTarget(tool, { host: "gateway" });
        expect(gatewayTool.getExecutionTimeoutMs?.({ ...args, host: "node" })).toBeUndefined();
      }
    },
  );
});
