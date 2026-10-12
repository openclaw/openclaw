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

const scheduledToolPolicy = {
  version: 1,
  mode: "trusted",
  execTarget: { host: "gateway", ask: "always" },
} as const;
function scheduledExec(options: Parameters<typeof createOpenClawCodingTools>[0] = {}) {
  return expectDefined(
    createOpenClawCodingTools({ scheduledToolPolicy, ...options }).find(
      (tool) => tool.name === "exec",
    ),
    "scheduled exec",
  );
}

describe("createOpenClawCodingTools scheduled exec target", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins exec to the scheduled cap's restrict-only target", async () => {
    const execTool = scheduledExec();
    const properties = Object.keys(
      (execTool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    expect(properties).toContain("command");
    for (const name of ["host", "security", "ask", "node"]) {
      expect(properties).not.toContain(name);
    }

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
    const exec = scheduledExec({ sessionPermissionPolicy: { root: process.cwd(), mode: "full" } });
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

  it.each([
    { host: "sandbox", source: "global" },
    { host: "node", source: "agent" },
    { host: "sandbox", source: "run" },
  ] as const)(
    "preserves the current $source host=$host restriction beside a saved pin",
    async ({ host, source }) => {
      const exec = scheduledExec({
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
