// Whatsapp plugin module implements channel actions behavior.
import { Type } from "typebox";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
  createActionGate,
  type ChannelMessageActionName,
  type ChannelMessageToolDiscovery,
  type OpenClawConfig,
  resolveWhatsAppReactionLevel,
} from "./channel-actions.runtime.js";

function areWhatsAppAgentReactionsEnabled(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return false;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return false;
  }
  return resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  }).agentReactionsEnabled;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return areWhatsAppAgentReactionsEnabled({
      cfg,
      accountId,
    });
  });
}

export function resolveWhatsAppAgentReactionGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!resolved.agentReactionsEnabled) {
    return undefined;
  }
  return resolved.agentReactionGuidance;
}

export function describeWhatsAppMessageActions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ChannelMessageToolDiscovery | null {
  if (!params.cfg.channels?.whatsapp) {
    return null;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  const actions = new Set<ChannelMessageActionName>();
  const canReact =
    params.accountId != null
      ? areWhatsAppAgentReactionsEnabled({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg);
  if (canReact) {
    actions.add("react");
  }
  if (gate("polls")) {
    actions.add("poll");
  }
  if (gate("sendMessage")) {
    actions.add("list-reply");
  }
  actions.add("upload-file");
  const schema = actions.has("list-reply")
    ? {
        actions: ["list-reply"] as const,
        properties: {
          selectedRowId: Type.Optional(
            Type.String({
              description: "WhatsApp list row id captured from inbound list context.",
            }),
          ),
          title: Type.Optional(
            Type.String({
              description: "Visible title for the selected WhatsApp list row.",
            }),
          ),
          description: Type.Optional(
            Type.String({
              description: "Visible description for the selected WhatsApp list row.",
            }),
          ),
          messageId: Type.Optional(
            Type.String({
              description: "Inbound WhatsApp list message id to quote when replying.",
            }),
          ),
          chatJid: Type.Optional(
            Type.String({
              description: "WhatsApp chat JID or phone target for the list reply.",
            }),
          ),
        },
      }
    : undefined;
  return {
    actions: Array.from(actions),
    ...(schema ? { schema } : {}),
  };
}
