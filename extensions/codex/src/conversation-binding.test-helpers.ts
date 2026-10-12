import type {
  PluginConversationBinding,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { Mock } from "vitest";

export function conversationMessage(
  content: string,
  options: Partial<Omit<PluginHookInboundClaimEvent, "content" | "commandAuthorized">> = {},
) {
  return { content, channel: "telegram", isGroup: false, commandAuthorized: true, ...options };
}

export function createConversationClaimFixtures(getRoot: () => string) {
  function conversationClaimContext(
    data: NonNullable<PluginConversationBinding["data"]>,
    sessionKey?: string,
    conversation = { channel: "telegram", conversationId: "5185575566" },
  ) {
    const pluginBinding: PluginConversationBinding = {
      bindingId: "binding-1",
      pluginId: "codex",
      pluginRoot: getRoot(),
      ...conversation,
      accountId: "default",
      boundAt: Date.now(),
      data,
    };
    return {
      channelId: conversation.channel,
      ...(sessionKey === undefined ? {} : { sessionKey }),
      pluginBinding,
    };
  }

  function legacyConversationData(
    sessionFile: string,
    owner: { agentId?: string; agentDir?: string } = {},
  ) {
    return {
      kind: "codex-app-server-session",
      version: 1,
      sessionFile,
      workspaceDir: getRoot(),
      ...owner,
    };
  }

  function boundConversationClaim(sessionFile: string, sessionKey?: string) {
    return {
      event: conversationMessage("continue", {
        bodyForAgent: "continue",
        ...(sessionKey ? { sessionKey } : {}),
      }),
      ctx: conversationClaimContext(legacyConversationData(sessionFile), sessionKey || undefined),
    };
  }

  return { conversationClaimContext, legacyConversationData, boundConversationClaim };
}

export function conversationThreadStartResult(
  cwd: string,
  threadId: string,
  canAcceptDirectInput?: boolean | null,
) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd,
    model: "gpt-5.4-mini",
    modelProvider: "openai",
    sandbox: { type: "workspaceWrite", networkAccess: false },
    serviceTier: null,
    activePermissionProfile: null,
    thread: {
      id: threadId,
      sessionId: "session-1",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd,
      projectId: null,
      cliVersion: "0.149.0",
      source: "unknown",
      ...(canAcceptDirectInput !== undefined ? { canAcceptDirectInput } : {}),
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
  };
}

export function mockCallArg(mock: Mock, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}
