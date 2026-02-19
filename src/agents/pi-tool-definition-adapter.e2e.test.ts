import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("sanitizes control sequences from tool error messages", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("\u001B]0;codex\u0007[?25h failure");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call3", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "failure",
    });
  });

  it("normalizes exec params for shell operators on Windows", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [],
      details: params,
    }));
    const tool = {
      name: "bash",
      label: "Bash",
      description: "runs commands",
      parameters: {},
      execute,
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    await defs[0].execute(
      "call4",
      { command: 'echo "one" && echo two' },
      undefined,
      undefined,
    );

    const calledParams = execute.mock.calls[0]?.[1] as { command?: string } | undefined;
    if (process.platform === "win32") {
      expect(calledParams?.command).toBe('cmd /d /s /c "echo \\"one\\" && echo two"');
      return;
    }
    expect(calledParams?.command).toBe('echo "one" && echo two');
  });
});
