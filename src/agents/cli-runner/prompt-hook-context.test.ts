import { describe, expect, it } from "vitest";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { buildCliPromptBuildHookContext } from "./prompt-hook-context.js";
import type { RunCliAgentParams } from "./types.js";

const base = {
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
  workspaceDir: "/tmp/workspace",
  prompt: "question",
  provider: "test-cli",
  timeoutMs: 1_000,
  runId: "run-1",
  agentId: "main",
} as RunCliAgentParams;
const prepared = { agentId: "main", workspaceDir: "/tmp/workspace", modelId: "test-model" };

describe("CLI prompt hook provenance", () => {
  it("passes the active native run trace to a protected cron hook", () => {
    const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
    const context = runWithDiagnosticTraceContext(trace, () =>
      buildCliPromptBuildHookContext(
        { ...base, trigger: "cron", sessionKey: "agent:main:arxi-proactive-steward" },
        prepared,
      ),
    );
    expect(context.trace).toEqual(trace);
    expect(context.requester).toBeUndefined();
    expect(buildCliPromptBuildHookContext(base, prepared).trace).toBeUndefined();
  });

  it("projects a private requester only from host-owned user turn fields", () => {
    const chatId = `telegram-private:axi_${"a".repeat(32)}:123`;
    const params = {
      ...base,
      trigger: "user" as const,
      chatId,
      senderId: "owner-123",
      senderIsOwner: true,
      messageChannel: "telegram",
    };
    expect(buildCliPromptBuildHookContext(params, prepared).requester).toEqual({
      senderId: "owner-123",
      conversationId: chatId,
      channel: "telegram",
      senderIsOwner: true,
    });
    expect(
      buildCliPromptBuildHookContext({ ...params, trigger: "cron" }, prepared).requester,
    ).toBeUndefined();
  });
});
