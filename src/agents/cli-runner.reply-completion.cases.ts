import { expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { markMcpLoopbackToolCallStarted } from "../gateway/mcp-http.loopback-runtime.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import { supervisorSpawnMock, type createManagedRun } from "./cli-runner.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

export function registerCliReplyCompletionTests(params: {
  createContext: (params: Partial<RunCliAgentParams>) => PreparedCliRunContext;
  completeToolCall: (
    call: Parameters<typeof markMcpLoopbackToolCallStarted>[0],
    result: unknown,
  ) => void;
  makeManagedRun: (overrides?: Partial<RunExit>) => ReturnType<typeof createManagedRun>;
  run: (context: PreparedCliRunContext) => Promise<EmbeddedAgentRunResult>;
}) {
  it.each([
    { name: "final source reply", target: "chat123", final: true, expected: "success" },
    { name: "source progress", target: "chat123", final: false, expected: "error" },
    { name: "another conversation", target: "elsewhere", final: true, expected: "error" },
  ] as const)(
    "settles NO_REPLY after $name without replaying a send",
    async ({ target, final, expected }) => {
      supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
        // SAFETY: the mocked method receives the process supervisor spawn arguments.
        const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
        params.completeToolCall(
          {
            captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
            toolName: "message",
            args: {
              action: "send",
              channel: "telegram",
              target,
              message: "sent without a terminal reply",
              final,
            },
          },
          { status: "sent" },
        );
        input.onStdout?.(
          `${JSON.stringify({ type: "result", session_id: "claude-session", result: SILENT_REPLY_TOKEN })}\n`,
        );
        return params.makeManagedRun();
      });
      const context = params.createContext({
        sessionKey: "agent:main:telegram:direct:chat123",
        runId: "run-required-source-delivery",
        sourceReplyDeliveryMode: "message_tool_only",
        messageChannel: "telegram",
        currentChannelId: "chat123",
        terminalReplyExpectation: "required",
      });
      context.backendResolved.config.output = "jsonl";

      const result = await params.run(context);

      expect(result.didSendViaMessagingTool).toBe(true);
      expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe(expected);
      expect(result.payloads).toEqual(
        target === "chat123" && !final
          ? [{ text: "The reply stopped after sending progress. Please try again.", isError: true }]
          : undefined,
      );
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    },
  );
}
