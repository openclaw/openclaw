import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

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
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("\u001B]0;codex\u0007[?25h failure");
      },
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call3", {}, undefined, undefined, extensionContext);

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
      parameters: Type.Object({}),
      execute,
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    await defs[0].execute(
      "call4",
      { command: 'echo "one" && echo two' },
      undefined,
      undefined,
      extensionContext,
    );

    const calledParams = execute.mock.calls[0]?.[1] as { command?: string } | undefined;
    if (process.platform === "win32") {
      expect(calledParams?.command).toBe("cmd /d /s /c 'echo \"one\" && echo two'");
      return;
    }
    expect(calledParams?.command).toBe('echo "one" && echo two');
  });

  it("keeps Windows paths and embedded quotes intact when shimming through cmd", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [],
      details: params,
    }));
    const tool = {
      name: "bash",
      label: "Bash",
      description: "runs commands",
      parameters: Type.Object({}),
      execute,
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    await defs[0].execute(
      "call5",
      { command: '"C:\\path\\to\\file.exe" "C:\\with space\\a.txt" && echo "done"' },
      undefined,
      undefined,
      extensionContext,
    );

    const calledParams = execute.mock.calls[0]?.[1] as { command?: string } | undefined;
    if (process.platform === "win32") {
      expect(calledParams?.command).toBe(
        `cmd /d /s /c '"C:\\path\\to\\file.exe" "C:\\with space\\a.txt" && echo "done"'`,
      );
      return;
    }
    expect(calledParams?.command).toBe(
      '"C:\\path\\to\\file.exe" "C:\\with space\\a.txt" && echo "done"',
    );
  });
});
