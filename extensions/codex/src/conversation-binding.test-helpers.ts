import type {
  PluginConversationBinding,
  PluginHookInboundClaimEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import type { Mock } from "vitest";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { handleCodexConversationBindingResolved } from "./conversation-binding-hooks.js";

export function conversationMessage(
  content: string,
  options: Partial<Omit<PluginHookInboundClaimEvent, "content" | "commandAuthorized">> = {},
) {
  return { content, channel: "telegram", isGroup: false, commandAuthorized: true, ...options };
}

export function createConversationClaimFixtures(
  getRoot: () => string,
  bindingStore: CodexAppServerBindingStore,
) {
  function conversationClaimContext(
    data: NonNullable<PluginConversationBinding["data"]>,
    sessionKey?: string,
    conversation = { channel: "telegram", conversationId: "5185575566" },
  ) {
    return {
      channelId: conversation.channel,
      ...(sessionKey === undefined ? {} : { sessionKey }),
      pluginBinding: {
        bindingId: "binding-1",
        pluginId: "codex",
        pluginRoot: getRoot(),
        ...conversation,
        accountId: "default",
        boundAt: Date.now(),
        data,
      } satisfies PluginConversationBinding,
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

  function denyConversationBinding(data: NonNullable<PluginConversationBinding["data"]>) {
    return handleCodexConversationBindingResolved(
      {
        status: "denied",
        decision: "deny",
        request: {
          data,
          conversation: { channel: "discord", accountId: "default", conversationId: "channel:1" },
        },
      },
      { bindingStore },
    );
  }

  return {
    conversationClaimContext,
    legacyConversationData,
    boundConversationClaim,
    denyConversationBinding,
  };
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
      ...threadStartResult(threadId, cwd).thread,
      cliVersion: "0.149.0",
      ...(canAcceptDirectInput !== undefined ? { canAcceptDirectInput } : {}),
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
