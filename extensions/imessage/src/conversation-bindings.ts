import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createAccountScopedConversationBindingManager,
  createAccountScopedConversationBindingManagerV2,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
  type AccountScopedConversationBindingManagerV2,
  type BindingTargetKind,
} from "openclaw/plugin-sdk/thread-bindings-runtime";

type IMessageBindingTargetKind = "subagent" | "acp";

type IMessageConversationBindingManager =
  AccountScopedConversationBindingManager<IMessageBindingTargetKind>;

const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.imessageConversationBindingsState",
);

function toSessionBindingTargetKind(raw: IMessageBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toIMessageTargetKind(raw: BindingTargetKind): IMessageBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

/** @deprecated Use createIMessageConversationBindingManagerV2; removed in the next Plugin SDK major. */
export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager {
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
