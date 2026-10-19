import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { markMcpLoopbackToolCallStarted } from "../gateway/mcp-http.loopback-runtime.js";
import type { RunExit } from "../process/supervisor/types.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { supervisorSpawnMock, type createManagedRun } from "./cli-runner.test-support.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { applyCliSessionBindingResult, getCliSessionBinding } from "./cli-session.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { FailoverError, hasModelFallbackStop } from "./failover-error.js";
import { extractStoredAssistantText } from "./tools/chat-history-text.js";
import { createMessageTool } from "./tools/message-tool-execution.js";

/** Register required-reply cases inside the reliability suite's existing process fixture. */
export function registerCliReplyCompletionTests({
  createContext,
  completeToolCall,
  makeManagedRun,
  admitContext,
  run,
  createSessionFixture,
  sessionParams,
  readTranscriptMessages,
}: {
  createContext: (params: Partial<RunCliAgentParams>) => PreparedCliRunContext;
  completeToolCall: (
    call: Parameters<typeof markMcpLoopbackToolCallStarted>[0],
    result: unknown,
  ) => void;
  makeManagedRun: (overrides?: Partial<RunExit>) => ReturnType<typeof createManagedRun>;
  admitContext: (context: PreparedCliRunContext) => Promise<{ close: () => void }>;
  run: (context: PreparedCliRunContext) => Promise<EmbeddedAgentRunResult>;
  createSessionFixture: (params: { sessionKey: string }) => {
    dir: string;
    sessionTarget: SessionTranscriptRuntimeTarget;
  };
  sessionParams: (
    sessionTarget: SessionTranscriptRuntimeTarget,
    workspaceDir: string,
  ) => Partial<RunCliAgentParams>;
  readTranscriptMessages: (sessionTarget: SessionTranscriptRuntimeTarget) => Promise<unknown[]>;
}) {
  it.each([
    { raw: "NO_REPLY\nNO_REPLY", visible: "NO_REPLY" },
    { raw: "NO_REPLY\nVisible answer", visible: "Visible answer" },
    { raw: "NO_REPLY\nNO_REPLY\nVisible answer", visible: "NO_REPLY\nVisible answer" },
  ])("preserves raw CLI output through stored-history reload: $raw", async ({ raw, visible }) => {
    const sessionKey = "agent:main:telegram:direct:cli-raw-history";
    const { dir, sessionTarget } = createSessionFixture({ sessionKey });
    const context = createContext({
      sessionKey,
      runId: "cli-raw-history",
      ...sessionParams(sessionTarget, dir),
      storePath: sessionTarget.storePath,
      persistAssistantTranscript: true,
      messageChannel: "telegram",
    });
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: raw }));

    const result = await run(context);
    const messages = await readTranscriptMessages(sessionTarget);

    expect(result.meta.terminalReply).toEqual({ disposition: "visible", text: visible });
    expect(result.payloads).toEqual([{ text: visible }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: raw }],
    });
    expect(extractStoredAssistantText(messages[0])).toBe(visible);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

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
    {
      name: "source progress",
      expected: "success",
      text: SILENT_REPLY_TOKEN,
    },
    {
      name: "empty source progress",
      expected: "error",
      text: "",
    },
  ] as const)("settles $name without replaying a send", async ({ expected, text }) => {
    supervisorSpawnMock.mockImplementationOnce(async (input) => {
      completeToolCall(
        {
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "message",
          args: {
            action: "send",
            channel: "telegram",
            target: "chat123",
            message: "sent without a terminal reply",
            final: false,
          },
        },
        { status: "sent" },
      );
      input.onStdout?.(
        `${JSON.stringify({ type: "result", session_id: "claude-session", result: text })}\n`,
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
      trigger: "user",
    });
    context.backendResolved.config.output = "jsonl";

    const result = await run(context);

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.meta.executionTrace?.attempts?.[0]?.result).toBe(expected);
    if (expected === "success") {
      expect(result.meta.terminalReply).toEqual({ disposition: "silent" });
      expect(result.payloads).toBeUndefined();
    } else {
      expect(result.meta.error).toMatchObject({ kind: "incomplete_turn", fallbackSafe: false });
      expect(result.payloads).toEqual([
        {
          text: "No answer was returned. Ask again if you still need one.",
          isError: true,
          isStatusNotice: true,
        },
      ]);
    }
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("does not mistake CLI WebChat progress for a final result", async () => {
    const sessionKey = "agent:main:webchat:dm:cli-internal-source";
    const { dir, sessionTarget } = createSessionFixture({ sessionKey });
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: dir } } },
    };
    setRuntimeConfigSnapshot(config);
    const context = createContext({
      sessionKey,
      runId: "cli-internal-source",
      ...sessionParams(sessionTarget, dir),
      config,
      messageChannel: "webchat",
      messageProvider: "webchat",
      sourceReplyDeliveryMode: "message_tool_only",
    });
    context.backendResolved.config.output = "jsonl";
    const tool = createMessageTool({
      config,
      preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "message_tool_only",
      agentSessionKey: sessionKey,
      runSessionKey: sessionKey,
      sessionId: sessionTarget.sessionId,
      agentId: "main",
      runId: context.params.runId,
    });
    const text = "Checking…";
    supervisorSpawnMock.mockImplementationOnce(async (input) => {
      const args = { action: "send", message: text, final: false };
      const toolResult = await tool.execute("cli-internal-source-send", args);
      expect(toolResult.details).toMatchObject({
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReplyTranscriptOwner: true,
      });
      completeToolCall(
        {
          captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
          toolName: "message",
          args,
        },
        toolResult,
      );
      input.onStdout?.(
        `${JSON.stringify({ type: "result", session_id: "claude-session", result: SILENT_REPLY_TOKEN })}\n`,
      );
      return makeManagedRun();
    });

    const result = await run(context);

    const assistantMessages = (await readTranscriptMessages(sessionTarget)).filter(
      (message) => isRecord(message) && message.role === "assistant",
    );
    expect(assistantMessages.map(readAssistantDisplayContent)).toEqual([[{ type: "text", text }]]);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    expect(result.payloads).toEqual([{ text }]);
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual([text]);
    expect(result.meta.error).toMatchObject({ kind: "incomplete_turn", fallbackSafe: false });
    expect(result.meta.executionTrace?.attempts?.map((attempt) => attempt.result)).toEqual([
      "error",
    ]);
    expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
  });

  it.each([false, true])(
    "requires a real child result even when continuation custody is %s",
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
      });

      const error = await run(context).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "FailoverError", reason: "empty_response" });
      expect(hasModelFallbackStop(error)).toBe(true);
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects whitespace-wrapped CLI silence when a private result is required", async () => {
    const text = " \tNO_REPLY\n";
    supervisorSpawnMock.mockResolvedValueOnce(makeManagedRun({ stdout: text }));
    const context = createContext({
      sessionKey: "agent:main:subagent:required-cli-reply",
      lane: "subagent",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_spawn" },
    });

    await expect(run(context)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "empty_response",
    });
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });
}
