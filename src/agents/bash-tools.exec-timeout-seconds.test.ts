/**
 * Exec timeout unit-naming tests.
 *
 * The exec timeout is in seconds while the sibling `yieldMs` and the process
 * tool's `timeout` are milliseconds. Code mode renders property names and types
 * and defers descriptions, so the field name has to carry the unit; a bare
 * `timeout` is a silent 1000x error. These tests pin that contract.
 */
import { describe, expect, it } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createExecTool } from "./bash-tools.js";
import { execSchema, nodeExecSchema, processSchema } from "./bash-tools.schemas.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

/** TypeBox optional wrappers do not surface `description` on their static type. */
function describedAs(schema: unknown): string {
  return (schema as { description?: string } | undefined)?.description ?? "";
}

describe("exec timeout unit naming", () => {
  it("exposes a unit-bearing timeoutSeconds field", () => {
    expect(execSchema.properties.timeoutSeconds).toBeDefined();
    expect(describedAs(execSchema.properties.timeoutSeconds)).toMatch(/seconds/);
  });

  it("no longer exposes a unit-ambiguous timeout field", () => {
    // The whole point: a model that sees only names and types must not be
    // offered a bare `timeout` next to a millisecond-based `yieldMs`.
    expect(execSchema.properties).not.toHaveProperty("timeout");
    expect(nodeExecSchema.properties).not.toHaveProperty("timeout");
  });

  it("exposes timeoutSeconds on the node-only exec surface too", () => {
    // nodeExecSchema hand-projects its fields, so a new exec field has to be
    // added there explicitly or node callers cannot discover it.
    expect(nodeExecSchema.properties.timeoutSeconds).toBeDefined();
  });

  it("leaves the process tool's millisecond timeout untouched", () => {
    // The collision this change removes: same name, different unit, in two
    // tools used together in one workflow. process keeps its own field.
    expect(describedAs(processSchema.properties.timeout)).toMatch(/millisecond/i);
  });
});

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
    { timeoutSec: 120, timeoutSeconds: undefined, expectedMs: 130_000 },
    { timeoutSec: 120, timeoutSeconds: 12, expectedMs: 22_000 },
    { timeoutSec: 120, timeoutSeconds: 0, expectedMs: 130_000 },
    { timeoutSec: undefined, timeoutSeconds: 0, expectedMs: 1_810_000 },
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

  it("leaves ordinary gateway exec on the harness's existing timeout policy", () => {
    for (const createTool of [createExecTool, createLazyExecTool]) {
      const tool = createTool({ host: "gateway", timeoutSec: 120 });
      expect(tool.getExecutionTimeoutMs?.({ command: "echo ready" })).toBeUndefined();
      expect(
        tool.getExecutionTimeoutMs?.({ command: "echo ready", timeoutSeconds: 0 }),
      ).toBeUndefined();
    }
  });
});
