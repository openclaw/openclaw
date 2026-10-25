import { expect, it, vi } from "vitest";
import {
  buildChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
} from "../../channels/streaming.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import type { CliToolUseStartDelta } from "../cli-output-contracts.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";

it("keeps native Bash detail without asserting ambiguous MCP execution", () => {
  const runId = "cli-bash-progress";
  const context = buildContext(runId);
  const tracking = {
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
  } as unknown as CliToolTracking;
  const handlers = createCliEventHandlers({
    context,
    toolTracking: tracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId) {
      events.push(event);
    }
  });
  const complete = (
    toolCallId: string,
    name: string,
    kind: CliToolUseStartDelta["kind"],
    command: string,
    result: string,
  ) => {
    handlers.emitParsedToolUseStart({ toolCallId, name, kind, args: { command } });
    handlers.emitParsedToolResult({ toolCallId, name, isError: false, result });
  };
  try {
    complete("bash-1", "Bash", "tool_use", "echo retained", "retained");

    const start = events.find((event) => event.stream === "tool" && event.data.phase === "start");
    const end = events.find((event) => event.stream === "item" && event.data.phase === "end");
    expect(end?.data).toMatchObject({
      status: "completed",
      meta: expect.stringContaining("echo retained"),
    });
    const options = { commandText: "raw" as const, detailMode: "raw" as const };
    const startLine = buildChannelProgressDraftLine(
      {
        event: "tool",
        name: "Bash",
        toolCallId: "bash-1",
        args: start?.data.args as Record<string, unknown>,
      },
      options,
    );
    const endLine = buildChannelProgressDraftLine(
      {
        event: "item",
        name: "Bash",
        toolCallId: "bash-1",
        itemId: "tool:bash-1",
        itemKind: "tool",
        status: "completed",
        commandBearing: true,
        meta: end?.data.meta as string | undefined,
      },
      options,
    );
    if (!startLine || !endLine) {
      throw new Error("expected Bash progress lines");
    }
    expect(
      mergeChannelProgressDraftLine([startLine], endLine, { maxLines: 4 })[0]?.detail,
    ).toContain("echo retained");

    for (const [toolCallId, name, expectedName, kind] of [
      ["mcp-1", "mcp__openclaw__exec", "exec", "mcp_tool_use"],
      ["mcp-generic-1", "mcp__openclaw__exec", "exec", "tool_use"],
      ["mcp-gemini-1", "mcp_openclaw_exec", "exec", "tool_use"],
      ["mcp-third-party-1", "mcp_docs_exec", "mcp_docs_exec", "tool_use"],
    ] as const) {
      complete(toolCallId, name, kind, "requested command", "result with ambiguous execution");
      const mcpTerminal = events.find(
        (event) =>
          event.stream === "item" &&
          event.data.phase === "end" &&
          event.data.toolCallId === toolCallId,
      );
      expect(mcpTerminal?.data).toMatchObject({ status: "completed", name: expectedName });
      expect(mcpTerminal?.data.meta).toBeUndefined();
    }
  } finally {
    dispose();
  }
});
