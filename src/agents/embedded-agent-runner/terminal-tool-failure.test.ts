import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunTerminalToolFailure } from "./terminal-tool-failure.js";

function resolve(error: string, toolName = "exec", errorCode?: string) {
  return resolveEmbeddedRunTerminalToolFailure({
    trigger: "cron",
    codeModeEngaged: true,
    lastToolError: { toolName, error, errorCode },
  });
}

const unknownTool = (toolName: string) => ({ source: "tool", toolName, code: "UNKNOWN_TOOL_ID" });

describe("resolveEmbeddedRunTerminalToolFailure", () => {
  it("projects a sanitized Code Mode cron failure", () => {
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        trigger: "cron",
        codeModeEngaged: true,
        lastToolError: {
          toolName: "exec",
          errorCode: "invalid_input",
          error:
            "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("projects a failed resumed Code Mode run from the wait control", () => {
    expect(
      resolve(
        "Unknown tool id: MCP.notes.read. Did you mean: MCP.notes.list? Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
        "wait",
        "invalid_input",
      ),
    ).toEqual(unknownTool("wait"));
  });

  it("recognizes the wrapped bridge error a live exec failure actually records", () => {
    // Real cron failure: Error prefix, bridge recovery phrasing, and stack frame.
    expect(
      resolve(
        "Error: Unknown tool id: MCP.notes.frobnicate. Did you mean: automations, browser? Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.\n    at settle (openclaw-code-mode:controller.js:125:49)\n",
        "exec",
        "internal_error",
      ),
    ).toEqual(unknownTool("exec"));
  });

  it("rejects multi-line text whose later lines mimic the formatter", () => {
    expect(
      resolve(
        "secret-ish output sk-live-4242\nUnknown tool id: MCP.notes.read. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
      ),
    ).toBeUndefined();
  });

  it("keeps ordinary exec, structured denials, and arbitrary private errors on existing paths", () => {
    const base = {
      trigger: "cron",
      lastToolError: { toolName: "exec", error: "command failed" },
    } as const;

    expect(resolveEmbeddedRunTerminalToolFailure(base)).toBeUndefined();
    expect(resolve("command failed", "exec", "SYSTEM_RUN_DENIED")).toBeUndefined();
    expect(
      resolve("Unknown tool id: MCP.notes.read; private output: /home/operator/.config/token"),
    ).toBeUndefined();
    expect(resolve("OPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
  });

  it("does not persist an identifier fragment that could be secret-shaped", () => {
    expect(
      resolve(
        "Unknown tool id: MCP.sk_test_abcdefghijklmnopqrstuvwxyz.read. Did you mean: MCP.notes.read? Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
      ),
    ).toEqual(unknownTool("exec"));
  });
});
