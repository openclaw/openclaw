import { expect, it, onTestFinished } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { SessionEntry } from "../config/sessions.js";
import type { markMcpLoopbackToolCallStarted } from "../gateway/mcp-http.loopback-runtime.js";
import type { RunExit } from "../process/supervisor/types.js";
import { supervisorSpawnMock, type createManagedRun } from "./cli-runner.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "./cli-session.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError, hasModelFallbackStop } from "./failover-error.js";

/** Register required-reply cases inside the reliability suite's existing process fixture. */
export function registerCliReplyCompletionTests({
  createContext,
  completeToolCall,
  makeManagedRun,
  admitContext,
  run,
}: {
  createContext: (params: Partial<RunCliAgentParams>) => PreparedCliRunContext;
  completeToolCall: (
    call: Parameters<typeof markMcpLoopbackToolCallStarted>[0],
    result: unknown,
  ) => void;
  makeManagedRun: (overrides?: Partial<RunExit>) => ReturnType<typeof createManagedRun>;
  admitContext: (context: PreparedCliRunContext) => Promise<{ close: () => void }>;
  run: (context: PreparedCliRunContext) => Promise<EmbeddedAgentRunResult>;
}) {
  it.each(["abort", "timeout", "session-expired", "fork-abort"] as const)(
    "does not replay delivery and resumes valid history after %s",
    async (failure) => {
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        completeToolCall(
          {
            captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
            toolName: "message",
            args: {
              action: "send",
              channel: "telegram",
              target: "chat123",
              message: "progress before interruption",
              mediaUrl: "https://example.com/done.png",
              final: false,
            },
          },
          { status: "sent" },
        );
        if (failure === "fork-abort") {
          input.onStdout?.(
            `${JSON.stringify({ type: "system", subtype: "init", session_id: "fork-successor" })}\n`,
          );
        }
        if (failure === "abort" || failure === "fork-abort") {
          throw new DOMException("Stopped by user", "AbortError");
        }
        if (failure === "session-expired") {
          throw new FailoverError("Native session expired", { reason: "session_expired" });
        }
        return makeManagedRun({
          reason: "no-output-timeout",
          exitCode: null,
          exitSignal: "SIGKILL",
          durationMs: 200,
          timedOut: true,
          noOutputTimedOut: true,
        });
      });
      const context = createContext({
        sessionKey: "agent:main:delivered-interruption",
        runId: "run-delivered-interruption",
      });
      context.reusableCliSession = { mode: "reuse", sessionId: "retained-cli-session" };
      context.openClawHistoryPrompt = "Earlier conversation history";
      const binding = { sessionId: "retained-cli-session", resumeCheckpointId: "prior-answer" };
      const entry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": binding },
      };

      if (failure === "fork-abort") {
        context.preparedBackend.backend.resumeArgs = ["--resume", "{sessionId}"];
        context.preparedBackend.backend.forkArg = "--fork-session";
        context.preparedBackend.backend.output = "jsonl";
        context.params.forkCliSessionOnResume = true;
        context.params.claimCliSessionFork = async () => true;
        context.params.persistCliSessionForkSuccessor = async (sessionId) => {
          entry.cliSessionBindings = { "claude-cli": { sessionId } };
        };
        onTestFinished((await admitContext(context)).close);
      }
      const result = await run(context);
      if (failure === "fork-abort") {
        expect(getCliSessionBinding(entry, "claude-cli")?.sessionId).toBe("fork-successor");
      }
      applyCliSessionBindingResult(entry, "claude-cli", result.meta.agentMeta);

      expect(result.didSendViaMessagingTool).toBe(true);
      expect(result.messagingToolSentTexts).toEqual(["progress before interruption"]);
      expect(result.messagingToolSentMediaUrls).toEqual(["https://example.com/done.png"]);
      expect(result.messagingToolSentTargets).toEqual([
        expect.objectContaining({ tool: "message", provider: "telegram", to: "chat123" }),
      ]);
      expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe("error");
      expect(result.meta.agentMeta?.contextTokens).toBe(150_000);
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
      const retained = getCliSessionBinding(entry, "claude-cli");
      const invalidated = failure === "session-expired" || failure === "fork-abort";
      expect(retained).toEqual(invalidated ? undefined : binding);

      supervisorSpawnMock.mockImplementationOnce(async () => makeManagedRun({ stdout: "status" }));
      const next = createContext({});
      next.reusableCliSession = retained
        ? { mode: "reuse", sessionId: retained.sessionId }
        : { mode: "none" };
      next.preparedBackend.backend.resumeArgs = ["--resume", "{sessionId}"];
      await run(next);
      const spawn = supervisorSpawnMock.mock.calls[1]?.[0];
      if (spawn?.mode !== "child") {
        throw new Error("Expected the next CLI turn to spawn a child process");
      }
      const argv = spawn.argv;
      if (invalidated) {
        expect(argv).not.toContain("--resume");
      } else {
        expect(argv).toEqual(expect.arrayContaining(["--resume", "retained-cli-session"]));
      }
    },
  );

  it.each([
    { name: "final source reply", target: "chat123", final: true, expected: "success" },
    { name: "source progress", target: "chat123", final: false, expected: "error" },
    { name: "another conversation", target: "elsewhere", final: true, expected: "error" },
  ] as const)(
    "settles NO_REPLY after $name without replaying a send",
    async ({ target, final, expected }) => {
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        completeToolCall(
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
        return makeManagedRun();
      });
      const context = createContext({
        sessionKey: "agent:main:telegram:direct:chat123",
        runId: "run-required-source-delivery",
        sourceReplyDeliveryMode: "message_tool_only",
        messageChannel: "telegram",
        currentChannelId: "chat123",
        terminalReplyExpectation: "required",
      });
      context.backendResolved.config.output = "jsonl";

      const result = await run(context);

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

  it.each([false, true])(
    "requires child continuation custody before accepting NO_REPLY (completion=%s)",
    async (expectsCompletionMessage) => {
      const child = {
        runId: "spawned-cli-child",
        childSessionKey: "agent:main:subagent:spawned-cli-child",
        expectsCompletionMessage,
      };
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        completeToolCall(
          {
            captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY,
            toolName: "sessions_spawn",
            args: { task: "review", expectsCompletionMessage },
          },
          { details: { status: "accepted", ...child } },
        );
        return makeManagedRun({ stdout: SILENT_REPLY_TOKEN });
      });
      const context = createContext({
        sessionKey: "agent:main:subagent:cli-parent",
        lane: "subagent",
        terminalReplyExpectation: "required",
      });

      const operation = run(context);

      if (expectsCompletionMessage) {
        await expect(operation).resolves.toMatchObject({ acceptedSessionSpawns: [child] });
      } else {
        const error = await operation.catch((caught: unknown) => caught);
        expect(error).toMatchObject({ name: "FailoverError", reason: "empty_response" });
        expect(hasModelFallbackStop(error)).toBe(true);
      }
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    },
  );

  it.each([SILENT_REPLY_TOKEN, JSON.stringify({ action: SILENT_REPLY_TOKEN })])(
    "rejects silent CLI output %j when a final reply is required",
    async (text) => {
      supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: text }));
      const context = createContext({
        sessionKey: "agent:main:subagent:required-cli-reply",
        lane: "subagent",
        terminalReplyExpectation: "required",
        inputProvenance: { kind: "inter_session", sourceTool: "sessions_spawn" },
      });

      await expect(run(context)).rejects.toMatchObject({
        name: "FailoverError",
        reason: "empty_response",
      });
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    },
  );
}
