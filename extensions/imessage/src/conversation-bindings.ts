import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createAccountScopedConversationBindingManager,
  createAccountScopedConversationBindingManagerV2,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
  type AccountScopedConversationBindingManagerV2,
  type BindingTargetKind,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { warnPluginSdkDeprecation } from "openclaw/plugin-sdk/thread-bindings-session-runtime";

type IMessageBindingTargetKind = "subagent" | "acp";

const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.imessageConversationBindingsState",
);

function toSessionBindingTargetKind(raw: IMessageBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toIMessageTargetKind(raw: BindingTargetKind): IMessageBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

/** @deprecated Use createIMessageConversationBindingManagerV2; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): AccountScopedConversationBindingManager<IMessageBindingTargetKind> {
  warnPluginSdkDeprecation({
    family: "conversation-bindings",
    method: "createIMessageConversationBindingManager",
    replacement: "createIMessageConversationBindingManagerV2",
  });
  return createAccountScopedConversationBindingManager({
    channel: "imessage",
    cfg: params.cfg,
    accountId: params.accountId,
    stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    toStoredTargetKind: toIMessageTargetKind,
    toSessionBindingTargetKind,
  });
}

/** Worker-owned manager used by bundled channel startup. */
export function createIMessageConversationBindingManagerV2(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): AccountScopedConversationBindingManagerV2<IMessageBindingTargetKind> {
  return createAccountScopedConversationBindingManagerV2({
    channel: "imessage",
    cfg: params.cfg,
    accountId: params.accountId,
    stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    toStoredTargetKind: toIMessageTargetKind,
    toSessionBindingTargetKind,
  });
}

export const testing = {
  resetIMessageConversationBindingsForTests() {
    resetAccountScopedConversationBindingsForTests({
      stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
    });
  },
};
