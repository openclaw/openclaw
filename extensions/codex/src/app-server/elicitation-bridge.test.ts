import { callGatewayTool, type EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAppServerElicitationRequest } from "./elicitation-bridge.js";

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

function buildApprovalElicitation() {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "codex_apps__github",
    mode: "form",
    message: "Approve app tool call?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          title: "Approve this tool call",
        },
        persist: {
          type: "string",
          title: "Persist choice",
          enum: ["session", "always"],
        },
      },
      required: ["approve"],
    },
  };
}

describe("Codex app-server elicitation bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("routes MCP tool approval elicitations through plugin approvals", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
      },
      _meta: null,
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("maps allow-always decisions onto session-scoped persistence when offered", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-2", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-2", decision: "allow-always" });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "accept",
      content: {
        approve: true,
        persist: "session",
      },
      _meta: null,
    });
  });

  it("fails closed when the approval route is unavailable", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "plugin:approval-3", decision: null });

    const result = await handleCodexAppServerElicitationRequest({
      requestParams: buildApprovalElicitation(),
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });

  it("ignores non-approval elicitation requests", async () => {
    const result = await handleCodexAppServerElicitationRequest({
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps__github",
        mode: "form",
        message: "Choose a template",
        _meta: {},
        requestedSchema: {
          type: "object",
          properties: {
            template: {
              type: "string",
              enum: ["simple", "fancy"],
            },
          },
          required: ["template"],
        },
      },
      paramsForRun: createParams(),
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });
});
