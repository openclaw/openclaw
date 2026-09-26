import { describe, expect, it, vi } from "vitest";
import {
  buildChannelProgressDraftLine,
  mergeChannelProgressDraftLine,
} from "../../channels/streaming.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

describe("Claude CLI command progress", () => {
  it("keeps native Bash detail without asserting ambiguous MCP execution", () => {
    const runId = "cli-bash-progress";
    const backend = {
      command: "claude",
      args: [],
      output: "jsonl" as const,
      input: "stdin" as const,
      serialize: true,
    };
    const context = {
      params: {
        admittedRunContext: createTestAdmittedRunContext(runId),
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        runId,
        provider: "claude-cli",
        model: "claude-haiku-4-5",
        timeoutMs: 1_000,
      },
      started: Date.now(),
      startedMonotonicMs: performance.now(),
      workspaceDir: "/tmp",
      backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
      preparedBackend: { backend, env: {} },
      executionTarget: { kind: "process" },
      reusableCliSession: { mode: "none" },
      hadSessionFile: false,
      contextEngineConfig: {},
      modelId: "claude-haiku-4-5",
      normalizedModel: "claude-haiku-4-5",
      systemPrompt: "system",
      systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
      claudeSkillsPluginArgs: [],
      authEpochVersion: 2,
    } as PreparedCliRunContext;
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
    try {
      handlers.emitCliToolUseStart({
        toolCallId: "bash-1",
        name: "Bash",
        kind: "tool_use",
        args: { command: "echo retained" },
      });
      handlers.emitCliToolResult({
        toolCallId: "bash-1",
        name: "Bash",
        isError: false,
        result: "retained",
      });

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

      handlers.emitCliToolUseStart({
        toolCallId: "mcp-1",
        name: "mcp__openclaw__exec",
        kind: "mcp_tool_use",
        args: { command: "requested command" },
      });
      handlers.emitCliToolResult({
        toolCallId: "mcp-1",
        name: "mcp__openclaw__exec",
        isError: false,
        result: "result with ambiguous execution",
      });
      const mcpEnd = events.find(
        (event) =>
          event.stream === "item" &&
          event.data.phase === "end" &&
          event.data.toolCallId === "mcp-1",
      );
      expect(mcpEnd?.data).toMatchObject({ status: "completed", name: "exec" });
      expect(mcpEnd?.data.meta).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
