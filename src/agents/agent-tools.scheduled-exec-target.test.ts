/**
 * Scheduled restrict-only exec pin enforcement in createOpenClawCodingTools.
 * A cap captured from a host-pinned creator surface must rebuild exec pinned to
 * that target; absence of the pin keeps baseline exec behavior.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

const shellSpies = vi.hoisted(() => ({
  defaults: vi.fn<(defaults?: ExecToolDefaults) => void>(),
  exec: vi.fn(async () => ({ content: [], details: {} })),
  process: vi.fn(async () => ({ content: [], details: {} })),
}));

vi.mock("./bash-tools.js", () => ({
  createExecTool: (defaults?: ExecToolDefaults) => {
    shellSpies.defaults(defaults);
    return {
      name: "exec",
      description: "exec test double",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          host: { type: "string" },
          security: { type: "string" },
          ask: { type: "string" },
          node: { type: "string" },
        },
        required: ["command", "host"],
      },
      execute: shellSpies.exec,
    };
  },
  createProcessTool: () => ({
    name: "process",
    description: "process test double",
    parameters: { type: "object", properties: {} },
    execute: shellSpies.process,
  }),
}));

describe("createOpenClawCodingTools scheduled exec target", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins exec to the scheduled cap's restrict-only target", async () => {
    const tools = createOpenClawCodingTools({
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway", ask: "always" },
      },
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    if (!execTool) {
      throw new Error("expected an exec tool on the scheduled surface");
    }
    // The pinned schema stops advertising host/security/ask/node entirely.
    const properties = Object.keys(
      (execTool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toContain("command");
    expect(properties).not.toContain("host");
    expect(properties).not.toContain("security");
    expect(properties).not.toContain("ask");
    expect(properties).not.toContain("node");

    await execTool.execute("call-1", {
      command: "echo hi",
      host: "node",
      node: "remote",
      security: "full",
      ask: "off",
    });
    expect(shellSpies.defaults).toHaveBeenCalledWith(
      expect.objectContaining({ host: "gateway", ask: "always" }),
    );
    expect(shellSpies.exec).toHaveBeenCalledWith(
      "call-1",
      { command: "echo hi", host: "gateway", ask: "always" },
      undefined,
      undefined,
    );
  });

  it("pins the whole tool lifecycle, including execution preparation", async () => {
    const prepare = vi.fn(async (args: unknown) => args);
    const finalize = vi.fn((params: unknown) => params);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const source: AnyAgentTool = {
      name: "exec",
      label: "Exec",
      description: "exec",
      parameters: { type: "object", properties: {} },
      prepareBeforeToolCallParams: prepare,
      finalizeBeforeToolCallParams: finalize,
      execute,
    };

    const pinned = pinExecToolTarget(source, { host: "gateway", ask: "always" });
    await pinned.prepareBeforeToolCallParams?.(
      { command: "echo hi", host: "node", node: "remote", security: "full", ask: "off" },
      { hookContext: undefined },
    );
    pinned.finalizeBeforeToolCallParams?.({ command: "echo hi", host: "node", ask: "off" }, {});

    expect(prepare).toHaveBeenCalledWith(
      { command: "echo hi", host: "gateway", ask: "always" },
      { hookContext: undefined },
    );
    expect(finalize).toHaveBeenCalledWith(
      { command: "echo hi", host: "gateway", ask: "always" },
      {},
    );
  });

  it("keeps the scheduled approval floor in a reused full-permission session", async () => {
    const tools = createOpenClawCodingTools({
      sessionPermissionPolicy: { root: process.cwd(), mode: "full" },
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway", ask: "always" },
      },
    });

    const exec = tools.find((tool) => tool.name === "exec");
    if (!exec) {
      throw new Error("expected an exec tool on the scheduled surface");
    }
    await exec.execute("call-full-session", { command: "echo hi" });
    expect(shellSpies.defaults).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "gateway",
        mode: undefined,
        security: "full",
        ask: "always",
        bypassHostApprovalFloors: false,
      }),
    );
    expect(createOpenClawTools).toHaveBeenCalledWith(
      expect.objectContaining({
        execOverrides: expect.objectContaining({
          host: "gateway",
          mode: undefined,
          security: "full",
          ask: "always",
        }),
      }),
    );
  });

  it("keeps baseline exec behavior without a scheduled exec target", async () => {
    const tools = createOpenClawCodingTools({
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    await execTool?.execute?.("call-2", { command: "echo hi", host: "node" });
    expect(shellSpies.exec).toHaveBeenCalledWith(
      "call-2",
      { command: "echo hi", host: "node" },
      undefined,
      undefined,
    );
  });

  it.each(
    (["sandbox", "node"] as const).flatMap((host) =>
      (["global", "agent", "run"] as const).map((source) => ({ host, source })),
    ),
  )(
    "preserves the current $source host=$host restriction beside a saved pin",
    async ({ host, source }) => {
      const tools = createOpenClawCodingTools({
        ...(source === "run"
          ? { exec: { host } }
          : source === "agent"
            ? {
                agentId: "main",
                config: { agents: { entries: { main: { tools: { exec: { host } } } } } },
              }
            : { config: { tools: { exec: { host } } } }),
        scheduledToolPolicy: {
          version: 1,
          mode: "trusted",
          execTarget: { host: "gateway" },
        },
      });
      const exec = expectDefined(
        tools.find((tool) => tool.name === "exec"),
        "scheduled exec tool",
      );
      await exec.execute("call-restricted-host", { command: "echo hi" });
      expect(shellSpies.defaults.mock.lastCall?.[0]?.host).toBe(host);
      expect(shellSpies.exec).toHaveBeenCalledWith(
        "call-restricted-host",
        { command: "echo hi", host: "gateway" },
        undefined,
        undefined,
      );
    },
  );
});
