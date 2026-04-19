import { callGatewayTool, type EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAppServerToolUserInputRequest } from "./request-user-input-bridge.js";

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
  } as unknown as EmbeddedRunAttemptParams;
}

function buildApprovalPrompt() {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-call-1",
    questions: [
      {
        id: "approval",
        header: "Approve app tool call?",
        question: "Allow GitHub to add labels through the app connector?",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Allow once", description: "Approve only this tool call." },
          {
            label: "Always allow on this connection",
            description: "Approve future matching tool calls.",
          },
          { label: "Deny", description: "Reject the tool call." },
        ],
      },
    ],
  };
}

describe("Codex app-server request-user-input bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("routes approval-shaped prompts through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerToolUserInputRequest({
      requestParams: buildApprovalPrompt(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      answers: {
        approval: {
          answers: ["Allow once"],
        },
      },
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({
        pluginId: "openclaw-codex-app-server",
        title: "Approve app tool call?",
        toolName: "codex_app_tool_approval",
        twoPhase: true,
      }),
      { expectFinal: false },
    );
  });

  it("maps allow-always decisions onto the broadest positive answer available", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-2", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-2", decision: "allow-always" });

    const result = await handleCodexAppServerToolUserInputRequest({
      requestParams: buildApprovalPrompt(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      answers: {
        approval: {
          answers: ["Always allow on this connection"],
        },
      },
    });
  });

  it("fails closed with the negative answer when approvals are unavailable", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "plugin:approval-3", decision: null });

    const result = await handleCodexAppServerToolUserInputRequest({
      requestParams: buildApprovalPrompt(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      answers: {
        approval: {
          answers: ["Deny"],
        },
      },
    });
  });

  it("ignores generic questionnaires that are not approval prompts", async () => {
    const result = await handleCodexAppServerToolUserInputRequest({
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "questionnaire-1",
        questions: [
          {
            id: "theme",
            header: "Pick a theme",
            question: "Which design direction should we use?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Bright", description: "Use a lighter palette." },
              { label: "Dark", description: "Use a darker palette." },
            ],
          },
        ],
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
